// Al inicio del archivo, agregar mongoose
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Mantener todas las constantes necesarias, solo remover SecurityBlock
const { Key, User, Stats, SecurityBlock, conectarDB, getLastKeys, generateKey, getActiveUsers } = require('./database');
const SecurityLog = require('../models/SecurityLog');

// Verificar configuración crítica
const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ADMIN_ID',
    'TELEGRAM_CHAT_ID',
    'MONGODB_URI'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ Error: Variables de entorno faltantes:', missingVars.join(', '));
    process.exit(1);
}

// Constantes de seguridad
const SUPER_ADMIN_ID = '6912929677';  // Tu ID hardcodeado
const PROTECTED_IDS = [SUPER_ADMIN_ID];  // IDs que nunca pueden ser removidos

const TELEGRAM_CONFIG = {
    // Bot administrativo
    adminBot: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },
    // Inicializar con array directo
    adminIds: [SUPER_ADMIN_ID],
    superAdminId: SUPER_ADMIN_ID
};

// Crear una única instancia del bot
let adminBot = null;

// Al inicio del archivo
global.activeUsers = new Map();

// Función para inicializar el bot solo si no existe
function initBot() {
    if (!adminBot) {
        adminBot = new TelegramBot(TELEGRAM_CONFIG.adminBot.token, {
            polling: {
                interval: 300,
                autoStart: true,
                params: {
                    timeout: 10
                }
            },
            filepath: false,
            baseApiUrl: 'https://api.telegram.org',
            onlyFirstMatch: true,
            request: {
                proxy: false,
                simple: false,
                forever: true,
                timeout: 15000,
                agentOptions: {
                    keepAlive: true
                }
            }
        });

        // Manejar errores de polling sin mostrarlos en consola
        adminBot.on('polling_error', (error) => {
            if (error.code === 'ETELEGRAM' && error.message.includes('Conflict')) {
                // Ignorar silenciosamente los errores de conflicto
                return;
            }
            // Log otros errores críticos
            if (!error.message.includes('ETIMEDOUT')) {
                console.error('Error crítico en Telegram:', error.message);
            }
        });
    }
    return adminBot;
}

// Inicializar el bot
initBot();

// Agregar configuración de seguridad
const securityConfig = {
    maxAttempts: 3,
    blockDuration: 3600000, // 1 hora
    blockedUsers: new Map(),
    attackPatterns: [
        /(?<!\/)(admin)/i,  // Excluir comandos que empiezan con /
        /password/i,
        /login/i,
        /hack/i,
        /inject/i,
        /script/i,
        /'|"|`/    // SQL injection
    ]
};

// Agregar función para obtener IP
async function getIP() {
    try {
        const response = await axios.get('https://api.ipify.org?format=json');
        return response.data.ip;
    } catch (error) {
        return 'No disponible';
    }
}

// Función para detectar ataques
function detectAttack(message, userId) {
    try {
        // No detectar ataques para Super Admin
        if (isSuperAdmin(userId)) {
            return false;
        }

        let detectedPattern = null;
        // Verificar patrones de ataque
        const isAttack = securityConfig.attackPatterns.some(pattern => {
            if (pattern.test(message)) {
                detectedPattern = pattern;
                return true;
            }
            return false;
        });

        if (isAttack) {
            const alertMsg = `🚨 *INTENTO DE ATAQUE DETECTADO*\n\n` +
                `👤 Usuario ID: ${userId}\n` +
                `💬 Mensaje: ${message}\n` +
                `⚠️ Patrón: ${detectedPattern}\n` +
                `⏰ Fecha: ${new Date().toLocaleString()}`;

            // Corregir el envío del mensaje
            if (TELEGRAM_CONFIG.adminIds[0]) {  // Usar el primer admin (Super Admin)
                adminBot.sendMessage(TELEGRAM_CONFIG.adminIds[0], alertMsg, {
                    parse_mode: 'Markdown'
                }).catch(error => {
                    console.error('Error enviando alerta:', error.message);
                });
            }

            // Bloquear usuario
            blockUser(userId);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error detectando ataque:', error);
        return false;
    }
}

// Función para bloquear usuarios
async function blockUser(userId, username, reason = 'Intento de ataque', ip = 'Unknown') {
    try {
        const block = new SecurityBlock({
            userId,
            username,
            reason,
            blockedAt: new Date(),
            expires: new Date(Date.now() + securityConfig.blockDuration),
            attackType: reason,
            attempts: 1,
            ip
        });

        await block.save();

        const blockMsg = `⛔ *Usuario Bloqueado*\n\n` +
            `🆔 ID: ${userId}\n` +
            `👤 Usuario: ${username}\n` +
            `⏰ Duración: 1 hora\n` +
            `📝 Razón: ${reason}\n` +
            `🌐 IP: ${ip}\n` +
            `📅 Fecha: ${new Date().toLocaleString()}`;

        adminBot.sendMessage(TELEGRAM_CONFIG.adminId, blockMsg, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Error guardando bloqueo:', error);
    }
}

// Función para verificar si un usuario está bloqueado
async function isBlocked(userId) {
    try {
        await conectarDB();
        const user = await User.findOne({ 
            'blockStatus.isBlocked': true,
            userId: userId 
        });
        return user ? true : false;
    } catch (error) {
        console.error('Error verificando bloqueo:', error);
        return false;
    }
}

// Verificar bloqueo antes de procesar mensajes
adminBot.on('message', async (msg) => {
    const userId = msg.from.id.toString();

    // Verificar bloqueo
    if (await isBlocked(userId)) {
        adminBot.sendMessage(msg.chat.id, '❌ Usuario bloqueado');
        return;
    }

    // Verificar si está bloqueado
    const blocked = securityConfig.blockedUsers.get(userId);
    if (blocked && Date.now() < blocked.expires) {
        return;
    }

    // Verificar si es un ataque
    if (detectAttack(msg.text, userId)) {
        return;
    }

    // Solo procesar mensajes del admin
    if (userId !== TELEGRAM_CONFIG.adminId) {
        const alertMsg = `⚠️ *Acceso No Autorizado*\n` +
            `👤 Usuario: ${msg.from.username || 'Desconocido'}\n` +
            `🆔 ID: ${userId}\n` +
            `💬 Mensaje: ${msg.text}\n` +
            `⏰ Fecha: ${new Date().toLocaleString()}`;
        
        adminBot.sendMessage(TELEGRAM_CONFIG.adminId, alertMsg, {
            parse_mode: 'Markdown'
        });
        return;
    }
});

// Función para enviar lives en tiempo real
async function enviarLiveEncontrada(liveData) {
    try {
        const bot = initBot(); // Usar la instancia única
        const mensaje = `✅ *LIVE ENCONTRADA*\n\n` +
            `💳 *Tarjeta:* ${liveData.tarjeta}\n` +
            `🌐 *Gate:* ${liveData.gate || 'AlemanChecker'}\n` +
            `⏰ *Fecha:* ${new Date().toLocaleString()}`;

        await bot.sendMessage(TELEGRAM_CONFIG.adminBot.chatId, mensaje, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        // Solo log errores críticos
        if (!error.message.includes('ETIMEDOUT') && !error.message.includes('Conflict')) {
            console.error('Error enviando mensaje:', error.message);
        }
    }
}

// Bot administrativo para comandos
adminBot.onText(/\/start/, (msg) => {
    if (msg.from.id.toString() !== TELEGRAM_CONFIG.adminId) return;
    adminBot.sendMessage(msg.chat.id, '✅ Bot administrativo iniciado');
});

// Comandos administrativos
const adminCommands = {
    '/users': async (msg) => {
        try {
            // Verificar si es admin
            if (!isAdmin(msg.from.id)) {
                await logUnauthorizedAccess(msg);
                return;
            }

            // Obtener usuarios activos de MongoDB
            const activeUsers = await User.find({ 
                'subscription.status': 'active',
                'blockStatus.isBlocked': false
            }).select('username subscription lastLogin createdAt');

            if (!activeUsers || activeUsers.length === 0) {
                await adminBot.sendMessage(msg.chat.id, '❌ No hay usuarios activos');
                return;
            }

            const mensaje = `👥 *Usuarios Activos (${activeUsers.length})*\n\n` +
                activeUsers.map(user => {
                    const lastActivity = user.lastLogin || user.createdAt;
                    const diasRestantes = user.subscription?.daysValidity || 0;
                    
                    return `👤 *${user.username}*\n` +
                        `├ Días: ${diasRestantes}\n` +
                        `└ Última actividad: ${lastActivity.toLocaleString()}`;
                }).join('\n\n');

            await adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error en comando /users:', error);
            await adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo usuarios');
        }
    },

    '/stats': async (msg) => {
        try {
            // Leer stats de MongoDB
            const stats = await Stats.findOne({}).sort({ lastUpdate: -1 });
            
            if (!stats) {
                // Si no hay stats, mostrar stats básicas
                const mensaje = `📊 *Estadísticas del Checker*\n\n` +
                    `👥 Usuarios Activos: ${global.activeUsers?.size || 0}\n` +
                    `🔄 Total Checks: 0\n` +
                    `✅ Lives: 0\n` +
                    `⏰ Sin actividad registrada`;

                return adminBot.sendMessage(msg.chat.id, mensaje, {
                    parse_mode: 'Markdown'
                });
            }

            const mensaje = `📊 *Estadísticas del Checker*\n\n` +
                `👥 Usuarios Activos: ${stats.activeUsers.length}\n` +
                `🔄 Total Checks: ${stats.totalChecks}\n` +
                `✅ Lives: ${stats.lives}\n` +
                `⏰ Última Actualización: ${stats.lastUpdate.toLocaleString()}\n\n` +
                `💻 *Estado del Servidor*\n` +
                `🧠 Memoria: ${Math.round(stats.serverStatus.memory / 1024 / 1024)}MB\n` +
                `⚡ CPU: ${stats.serverStatus.cpu.toFixed(2)}%\n` +
                `⌛ Uptime: ${Math.round(stats.serverStatus.uptime / 3600)}h`;

            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            console.error('Error obteniendo stats:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo estadísticas');
        }
    },

    '/help': (msg) => {
        const help = `🤖 *Comandos Administrativos*\n\n` +
            `/users - Ver usuarios activos\n` +
            `/stats - Ver estadísticas\n` +
            `/genkey [días] - Generar nueva key\n` +
            `/keys - Ver últimas keys\n` +
            `/allkeys - Ver todas las keys\n` +
            `/allusers - Ver todos los usuarios\n` +
            `/delkey [key] - Eliminar una key\n` +
            `/security - Ver intentos de ataque\n` +
            `/help - Mostrar esta ayuda\n` +
            `/block <user> <24h|48h|week|permanent> [razón] - Bloquear usuario\n` +
            `/unblock <user> - Desbloquear usuario\n` +
            `/lives [username] - Ver últimas lives (todas o por usuario)\n` +
            `${isSuperAdmin(msg.from.id) ? 
                `\n👑 *Comandos Super Admin*\n` +
                `/addadmin <ID> - Agregar nuevo admin\n` +
                `/deladmin <ID> - Remover admin\n` +
                `/admins - Ver lista de admins\n`
                : ''}`; // Solo mostrar comandos de admin si es super admin
        
        adminBot.sendMessage(msg.chat.id, help, {
            parse_mode: 'Markdown'
        });
    },
    '/genkey': async (msg, args) => {
        try {
            let days = 30; // Valor por defecto
            let timeUnit = 'días';

            if (args.length > 0) {
                if (args[0] === 'h' && args[1]) {
                    // Convertir horas a días
                    days = parseFloat(args[1]) / 24;
                    timeUnit = 'horas';
                } else if (args[0] === 'd' && args[1]) {
                    days = parseInt(args[1]);
                } else {
                    days = parseInt(args[0]);
                }
            }

            // Validar el número de días
            if (isNaN(days) || days <= 0) {
                const helpMsg = `📝 *Uso del comando:*\n` +
                    `/genkey 15 - Key de 15 días\n` +
                    `/genkey 30 - Key de 30 días\n` +
                    `/genkey 60 - Key de 60 días\n` +
                    `/genkey h 12 - Key por horas (ej: 12 horas)\n` +
                    `/genkey d 5 - Key por días específicos (ej: 5 días)`;
                
                adminBot.sendMessage(msg.chat.id, helpMsg, {
                    parse_mode: 'Markdown'
                });
                return;
            }

            const key = await generateKey(days);
            const admin = {
                adminId: msg.from.id,
                adminUsername: msg.from.username,
                adminName: msg.from.first_name
            };

            // Actualizar la key con info del admin
            await Key.findByIdAndUpdate(key._id, {
                createdBy: admin
            });

            const mensaje = `🔑 *Nueva Key Generada*\n\n` +
                `📌 Key: \`${key.key}\`\n` +
                `⏰ Duración: ${timeUnit === 'horas' ? `${days * 24} horas` : `${days} días`}\n` +
                `📅 Expira: ${key.expiresAt.toLocaleString()}\n` +
                `✨ Estado: Disponible\n` +
                `👨‍💻 Creada por: @${msg.from.username}\n` +
                `🆔 Admin ID: ${msg.from.id}`;

            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error generando key:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error generando key');
        }
    },
    '/keys': async (msg) => {
        try {
            const keys = await getLastKeys(10);
            
            const keyList = keys.map(key => 
                `🔑 *Key:* \`${key.key}\`\n` +
                `📅 Creada: ${key.createdAt.toLocaleString()}\n` +
                `⌛ Expira: ${key.expiresAt.toLocaleString()}\n` +
                `✨ Estado: ${key.estado}\n` +
                `👤 Usuario: ${key.usedBy || 'Sin usar'}\n` +
                `👨‍💻 Creada por: ${key.createdBy?.adminUsername || 'Sistema'}\n` +
                `🆔 Admin ID: ${key.createdBy?.adminId || 'Sistema'}\n`
            ).join('\n');

            const mensaje = `📋 *Últimas 10 Keys*\n\n${keyList}`;
            
            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            console.error('Error en /keys:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo keys');
        }
    },
    '/delkey': async (msg, args) => {
        try {
            const keyToDelete = args[0];
            if (!keyToDelete) {
                adminBot.sendMessage(msg.chat.id, '❌ Debes especificar una key');
                return;
            }

            const result = await Key.deleteOne({ key: keyToDelete });
            
            if (result.deletedCount > 0) {
                adminBot.sendMessage(msg.chat.id, '✅ Key eliminada correctamente');
            } else {
                adminBot.sendMessage(msg.chat.id, '❌ Key no encontrada');
            }
        } catch (error) {
            adminBot.sendMessage(msg.chat.id, '❌ Error eliminando key');
        }
    },
    '/allkeys': async (msg) => {
        try {
            const keys = await Key.find().sort({ createdAt: -1 });
            
            const keyList = keys.map(key => 
                `🔑 *Key:* \`${key.key}\`\n` +
                `📅 Creada: ${key.createdAt.toLocaleString()}\n` +
                `⏰ Expira: ${key.expiresAt.toLocaleString()}\n` +
                `⌛ Días: ${key.daysValidity}\n` +
                `✨ Estado: ${key.used ? '🔴 Usada' : '🟢 Disponible'}\n`
            ).join('\n');

            // Dividir mensaje si es muy largo (límite de Telegram)
            const chunks = keyList.match(/.{1,4000}/g) || [];
            
            await adminBot.sendMessage(msg.chat.id, `📋 *Total Keys: ${keys.length}*`, {
                parse_mode: 'Markdown'
            });

            for (const chunk of chunks) {
                await adminBot.sendMessage(msg.chat.id, chunk, {
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo keys');
            console.error('Error en /allkeys:', error);
        }
    },
    '/allusers': async (msg) => {
        try {
            console.log('🔍 Buscando usuarios...');
            const users = await User.find().sort({ createdAt: -1 });
            
            if (!users || users.length === 0) {
                adminBot.sendMessage(msg.chat.id, '❌ No hay usuarios registrados');
                return;
            }

            console.log(`✅ ${users.length} usuarios encontrados`);
            
            const userList = users.map(user => {
                const subscription = user.subscription || {};
                const remainingDays = subscription.endDate ? 
                    Math.ceil((new Date(subscription.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : 
                    0;

                return `👤 *Usuario:* ${user.username}\n` +
                    `🔑 Key: \`${user.key || 'N/A'}\`\n` +
                    `📅 Registrado: ${user.createdAt?.toLocaleString() || 'N/A'}\n` +
                    `⏰ Último login: ${user.lastLogin?.toLocaleString() || 'N/A'}\n` +
                    `📊 Estado: ${subscription.status || 'N/A'}\n` +
                    `⌛ Días restantes: ${remainingDays}\n` +
                    `👑 Admin: ${user.isAdmin ? 'Sí' : 'No'}\n`;
            }).join('\n');

            // Dividir mensaje si es muy largo
            const chunks = userList.match(/.{1,4000}/g) || [];
            
            await adminBot.sendMessage(msg.chat.id, `📋 *Total Usuarios: ${users.length}*`, {
                parse_mode: 'Markdown'
            });

            for (const chunk of chunks) {
                await adminBot.sendMessage(msg.chat.id, chunk, {
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            console.error('Error en /allusers:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo usuarios');
        }
    },
    '/block': async (msg, args) => {
        try {
            if (args.length < 2) {
                adminBot.sendMessage(msg.chat.id, 
                    '❌ Uso: /block <username> <24h|48h|week|permanent> [razón]');
                return;
            }

            const username = args[0];
            const blockType = args[1].toLowerCase();
            const reason = args.slice(2).join(' ') || 'No especificada';

            let blockDuration;
            let blockMessage;

            switch (blockType) {
                case '24h':
                    blockDuration = 24 * 60 * 60 * 1000;
                    blockMessage = '24 horas';
                    break;
                case '48h':
                    blockDuration = 48 * 60 * 60 * 1000;
                    blockMessage = '48 horas';
                    break;
                case 'week':
                    blockDuration = 7 * 24 * 60 * 60 * 1000;
                    blockMessage = '1 semana';
                    break;
                case 'permanent':
                    blockDuration = null;
                    blockMessage = 'permanentemente';
                    break;
                default:
                    adminBot.sendMessage(msg.chat.id, '❌ Tipo de bloqueo inválido');
                    return;
            }

            const user = await User.findOne({ username });
            if (!user) {
                adminBot.sendMessage(msg.chat.id, '❌ Usuario no encontrado');
                return;
            }

            // Actualizar estado de bloqueo
            user.blockStatus = {
                isBlocked: true,
                reason,
                blockedAt: new Date(),
                blockedUntil: blockDuration ? new Date(Date.now() + blockDuration) : null,
                blockType
            };
            
            // Forzar cierre de la aplicación
            user.forceClose = true;
            await user.save();

            const mensaje = `🚫 *Usuario Bloqueado*\n\n` +
                `👤 Usuario: ${username}\n` +
                `⏰ Duración: ${blockMessage}\n` +
                `📅 Hasta: ${user.blockStatus.blockedUntil?.toLocaleString() || 'Permanente'}\n` +
                `📝 Razón: ${reason}\n` +
                `🔄 Acción: Se cerrará la aplicación del usuario`;

            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error en comando block:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error al bloquear usuario');
        }
    },
    '/unblock': async (msg, args) => {
        try {
            if (!args[0]) {
                adminBot.sendMessage(msg.chat.id, '❌ Especifica el username');
                return;
            }

            const username = args[0];
            const user = await User.findOne({ username });

            if (!user) {
                adminBot.sendMessage(msg.chat.id, '❌ Usuario no encontrado');
                return;
            }

            // Actualizar directamente en el documento encontrado
            user.blockStatus = {
                isBlocked: false,
                reason: null,
                blockedAt: null,
                blockedUntil: null,
                blockType: null
            };
            user.forceClose = false;
            
            await user.save();

            adminBot.sendMessage(msg.chat.id, 
                `✅ Usuario ${username} desbloqueado correctamente\n\nforceClose: ${user.forceClose}`, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error en comando unblock:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error al desbloquear usuario');
        }
    },
    '/addadmin': async (msg, args) => {
        try {
            // Verificación estricta de Super Admin
            if (!isSuperAdmin(msg.from.id)) {
                adminBot.sendMessage(msg.chat.id, '⛔ Acceso denegado: Solo el Super Admin puede gestionar administradores');
                // Logging de intento no autorizado
                console.log(`🚨 Intento no autorizado de modificar admins por: ${msg.from.id}`);
                return;
            }

            if (!args[0]) {
                adminBot.sendMessage(msg.chat.id, '❌ Uso: /addadmin <ID_TELEGRAM>');
                return;
            }

            const newAdminId = args[0];
            
            // Agregar el nuevo admin a la lista
            if (!TELEGRAM_CONFIG.adminIds.includes(newAdminId)) {
                TELEGRAM_CONFIG.adminIds.push(newAdminId);
                
                const mensaje = `✅ *Nuevo Administrador Agregado*\n\n` +
                    `🆔 ID: ${newAdminId}\n` +
                    `📅 Fecha: ${new Date().toLocaleString()}\n` +
                    `👑 Agregado por: @${msg.from.username}`;

                adminBot.sendMessage(msg.chat.id, mensaje, {
                    parse_mode: 'Markdown'
                });
            } else {
                adminBot.sendMessage(msg.chat.id, '❌ Este ID ya es administrador');
            }
        } catch (error) {
            console.error('Error agregando admin:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error agregando administrador');
        }
    },
    '/deladmin': async (msg, args) => {
        try {
            if (!isSuperAdmin(msg.from.id)) {
                adminBot.sendMessage(msg.chat.id, '⛔ Acceso denegado');
                return;
            }

            if (!args[0]) {
                adminBot.sendMessage(msg.chat.id, '❌ Uso: /deladmin <ID_TELEGRAM>');
                return;
            }

            const adminToRemove = args[0];
            
            // Protección contra remover Super Admin
            if (PROTECTED_IDS.includes(adminToRemove)) {
                adminBot.sendMessage(msg.chat.id, '⚠️ No se puede remover al Super Admin');
                return;
            }

            const index = TELEGRAM_CONFIG.adminIds.indexOf(adminToRemove);
            if (index > -1) {
                TELEGRAM_CONFIG.adminIds.splice(index, 1);
                adminBot.sendMessage(msg.chat.id, '✅ Administrador removido correctamente');
            } else {
                adminBot.sendMessage(msg.chat.id, '❌ ID no encontrado en la lista de administradores');
            }
        } catch (error) {
            console.error('Error removiendo admin:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error removiendo administrador');
        }
    },
    '/security': async (msg) => {
        try {
            if (!isAdmin(msg.from.id)) {
                await logUnauthorizedAccess(msg);
                return;
            }

            const intentos = await SecurityLog.find()
                .sort({ timestamp: -1 })
                .limit(10);

            if (!intentos.length) {
                await adminBot.sendMessage(msg.chat.id, '✅ No hay intentos de acceso no autorizados registrados', {
                    parse_mode: 'Markdown'
                });
                return;
            }

            const mensaje = `🔒 *Últimos ${intentos.length} intentos de acceso no autorizados:*\n\n` +
                intentos.map(intento => 
                    `👤 Usuario: ${intento.username}\n` +
                    `🆔 ID: ${intento.userId}\n` +
                    `💬 Comando: ${intento.command}\n` +
                    `⏰ Fecha: ${new Date(intento.timestamp).toLocaleString()}\n`
                ).join('\n');

            await adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            console.error('Error en comando /security:', error);
            await adminBot.sendMessage(msg.chat.id, '❌ Error al obtener el registro de seguridad');
        }
    },
    '/lives': async (msg, args) => {
        try {
            if (!isAdmin(msg.from.id)) {
                await logUnauthorizedAccess(msg);
                return;
            }

            // Esperar a que la conexión esté establecida
            if (!mongoose.connection || !mongoose.connection.db) {
                await adminBot.sendMessage(msg.chat.id, '❌ Error: Base de datos no conectada');
                return;
            }

            let lives;
            const livesCollection = mongoose.connection.db.collection('lives');

            try {
                // Si no hay argumentos, mostrar las últimas 10 lives generales
                if (!args || args.length === 0) {
                    lives = await livesCollection.find()
                        .sort({ fechaEncontrada: -1 })
                        .limit(10)
                        .toArray();
                } 
                // Si hay un username, buscar por ese usuario
                else {
                    const username = args[0];
                    lives = await livesCollection.find({ 'checkedBy.username': username })
                        .sort({ fechaEncontrada: -1 })
                        .limit(10)
                        .toArray();
                }

                if (!lives || lives.length === 0) {
                    await adminBot.sendMessage(msg.chat.id, '❌ No se encontraron lives', {
                        chat_id: msg.chat.id
                    });
                    return;
                }

                // Enviar cada live en un mensaje separado
                for (const live of lives) {
                    const mensaje = `💳 *LIVE ENCONTRADA*\n\n` +
                        `CC: ${live.tarjeta.numero}|${live.tarjeta.fecha}|${live.tarjeta.cvv}\n` +
                        `🏦 Banco: ${live.detalles.banco}\n` +
                        `🌍 País: ${live.detalles.pais}\n` +
                        `💠 Nivel: ${live.detalles.nivel}\n` +
                        `🔄 Gate: ${live.detalles.gate}\n` +
                        `💬 Respuesta: ${live.detalles.respuesta}\n` +
                        `👤 Checker: ${live.checkedBy.username || 'Unknown'}\n` +
                        `⏰ Fecha: ${new Date(live.fechaEncontrada).toLocaleString()}`;

                    await adminBot.sendMessage(msg.chat.id, mensaje, {
                        parse_mode: 'Markdown',
                        chat_id: msg.chat.id
                    });
                }

            } catch (dbError) {
                console.error('Error accediendo a la colección:', dbError);
                await adminBot.sendMessage(msg.chat.id, '❌ Error accediendo a la base de datos', {
                    chat_id: msg.chat.id
                });
            }

        } catch (error) {
            console.error('Error en comando /lives:', error);
            await adminBot.sendMessage(msg.chat.id, '❌ Error obteniendo lives', {
                chat_id: msg.chat.id
            });
        }
    }
};

// Procesar comandos administrativos
adminBot.on('message', (msg) => {
    if (!isAdmin(msg.from.id)) {
        console.log('Intento de acceso no autorizado:', msg.from);
        return;
    }

    const parts = msg.text.split(' ');
    const command = parts[0];
    const args = parts.slice(1);

    if (adminCommands[command]) {
        adminCommands[command](msg, args);
    }
});

// Función para registrar intentos de acceso no autorizados
async function logUnauthorizedAccess(msg) {
    try {
        // Guardar en la base de datos
        await SecurityLog.create({
            username: msg.from.username,
            userId: msg.from.id,
            command: msg.text
        });

        const now = new Date();
        const mensaje = `⚠️ *Acceso No Autorizado*\n` +
                       `👤 Usuario: ${msg.from.username}\n` +
                       `🆔 ID: ${msg.from.id}\n` + 
                       `💬 Mensaje: ${msg.text}\n` +
                       `⏰ Fecha: ${now.toLocaleString()}`;

        // Enviar notificación al admin
        await adminBot.sendMessage(TELEGRAM_CONFIG.adminId, mensaje, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Error al registrar acceso no autorizado:', error);
    }
}

// Agregar el servidor HTTP para mantenerlo activo en hosting
if (process.env.NODE_ENV === 'production') {
    require('http').createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('Bot Administrativo Activo');
    }).listen(process.env.PORT || 3000);

    console.log('🤖 Bot Administrativo iniciado en modo producción');
}

// Manejar errores para evitar caídas
process.on('uncaughtException', (err) => {
    console.error('Error no capturado:', err);
    // Notificar al admin
    adminBot.sendMessage(TELEGRAM_CONFIG.adminId, 
        `❌ *Error no capturado*\n\n${err.message}`, 
        { parse_mode: 'Markdown' }
    ).catch(() => {});
});

process.on('unhandledRejection', (err) => {
    console.error('Promesa rechazada no manejada:', err);
    // Notificar al admin
    adminBot.sendMessage(TELEGRAM_CONFIG.adminId, 
        `❌ *Promesa rechazada*\n\n${err.message}`, 
        { parse_mode: 'Markdown' }
    ).catch(() => {});
});

// Al inicio, después de inicializar el bot
async function initializeBot() {
    try {
        console.log('🤖 Bot Administrativo iniciado en modo', process.env.NODE_ENV || 'desarrollo');
        
        // Intentar conectar a MongoDB
        const dbConnected = await conectarDB();
        if (!dbConnected) {
            throw new Error('No se pudo conectar a MongoDB');
        }

        // Luego iniciar el bot
        return initBot();
    } catch (error) {
        console.error('❌ Error inicializando:', error);
        throw error;
    }
}

// Inicializar el bot solo después de conectar a MongoDB
let botInstance = null;
(async () => {
    try {
        botInstance = await initializeBot();
    } catch (error) {
        console.error('Error fatal:', error);
        process.exit(1);
    }
})();

// Modificar la verificación de admin
function isAdmin(userId) {
    return TELEGRAM_CONFIG.adminIds.includes(userId.toString());
}

function isSuperAdmin(userId) {
    return userId.toString() === SUPER_ADMIN_ID;
}

module.exports = {
    TELEGRAM_CONFIG,
    adminBot: initBot(), // Exportar la instancia única
    enviarLiveEncontrada
}; 