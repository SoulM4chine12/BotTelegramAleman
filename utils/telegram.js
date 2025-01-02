// Funciones relacionadas con Telegram
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Key, User } = require('./database');

const TELEGRAM_CONFIG = {
    // Bot administrativo
    adminBot: {
        token: '7806023762:AAGX7z2VwmqVFCRSyMqm7rsgLmPs1imWD1g',
        chatId: '6912929677'
    },
    adminId: '6912929677'  // Tu ID personal
};

// Crear una única instancia del bot
let adminBot = null;

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
        /admin/i,
        /password/i,
        /login/i,
        /hack/i,
        /inject/i,
        /script/i,
        /\/?../i,  // Path traversal
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

            // Enviar alerta al admin
            adminBot.sendMessage(TELEGRAM_CONFIG.adminId, alertMsg, {
                parse_mode: 'Markdown'
            });

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
function blockUser(userId) {
    securityConfig.blockedUsers.set(userId, {
        blockedAt: Date.now(),
        expires: Date.now() + securityConfig.blockDuration
    });

    // Notificar bloqueo
    const blockMsg = `⛔ *Usuario Bloqueado*\n\n` +
        `🆔 ID: ${userId}\n` +
        `⏰ Duración: 1 hora\n` +
        `📅 Fecha: ${new Date().toLocaleString()}`;

    adminBot.sendMessage(TELEGRAM_CONFIG.adminId, blockMsg, {
        parse_mode: 'Markdown'
    });
}

// Modificar el listener de mensajes del bot principal
adminBot.on('message', async (msg) => {
    const userId = msg.from.id.toString();

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
        const activeUsers = global.activeUsers;
        const mensaje = `👥 *Usuarios Activos (${activeUsers.size})*\n\n` +
            Array.from(activeUsers.entries())
                .map(([user, lastActivity]) => {
                    const time = new Date(lastActivity).toLocaleString();
                    return `👤 *${user}*\n└ Última actividad: ${time}`;
                })
                .join('\n\n');
        
        adminBot.sendMessage(msg.chat.id, mensaje || '❌ No hay usuarios activos', {
            parse_mode: 'Markdown'
        });
    },
    '/stats': async (msg) => {
        const stats = {
            usuarios: global.activeUsers.size,
            checkerActivo: global.checkerActivo,
            gate: global.currentGate
        };

        const mensaje = `📊 *Estadísticas del Checker*\n\n` +
            `👥 Usuarios Activos: ${stats.usuarios}\n` +
            `🔄 Checker: ${stats.checkerActivo ? '✅ Activo' : '❌ Inactivo'}\n` +
            `🌐 Gate: ${stats.gate || 'N/A'}`;

        adminBot.sendMessage(msg.chat.id, mensaje, {
            parse_mode: 'Markdown'
        });
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
            `/unblock <user> - Desbloquear usuario`;
        
        adminBot.sendMessage(msg.chat.id, help, {
            parse_mode: 'Markdown'
        });
    },
    '/genkey': async (msg, args) => {
        try {
            const days = parseInt(args[0]) || 30; // Por defecto 30 días
            const key = crypto.randomBytes(16).toString('hex').toUpperCase();
            
            // Crear nueva key en MongoDB
            const newKey = new Key({
                key: key,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + (days * 24 * 60 * 60 * 1000)),
                status: 'unused',
                createdBy: 'admin-bot'
            });

            await newKey.save();

            const mensaje = `🔑 *Nueva Key Generada*\n\n` +
                `📌 Key: \`${key}\`\n` +
                `⏰ Duración: ${days} días\n` +
                `📅 Expira: ${newKey.expiresAt.toLocaleString()}\n` +
                `✨ Estado: Sin usar`;

            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            adminBot.sendMessage(msg.chat.id, '❌ Error generando key');
            console.error('Error generando key:', error);
        }
    },
    '/keys': async (msg) => {
        try {
            const keys = await Key.find().sort({ createdAt: -1 }).limit(10);
            
            const keyList = keys.map(key => 
                `🔑 *Key:* \`${key.key}\`\n` +
                `📅 Expira: ${key.expiresAt.toLocaleString()}\n` +
                `✨ Estado: ${key.status}\n` +
                `👤 Usuario: ${key.usedBy || 'N/A'}\n`
            ).join('\n');

            const mensaje = `📋 *Últimas 10 Keys*\n\n${keyList}`;
            
            adminBot.sendMessage(msg.chat.id, mensaje, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
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
                    blockDuration = 24 * 60 * 60 * 1000; // 24 horas
                    blockMessage = '24 horas';
                    break;
                case '48h':
                    blockDuration = 48 * 60 * 60 * 1000; // 48 horas
                    blockMessage = '48 horas';
                    break;
                case 'week':
                    blockDuration = 7 * 24 * 60 * 60 * 1000; // 1 semana
                    blockMessage = '1 semana';
                    break;
                case 'permanent':
                    blockDuration = null; // Bloqueo permanente
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

            user.blockStatus = {
                isBlocked: true,
                reason,
                blockedAt: new Date(),
                blockedUntil: blockDuration ? new Date(Date.now() + blockDuration) : null,
                blockType
            };

            await user.save();

            // Notificar bloqueo
            const mensaje = `🚫 *Usuario Bloqueado*\n\n` +
                `👤 Usuario: ${username}\n` +
                `⏰ Duración: ${blockMessage}\n` +
                `📅 Hasta: ${user.blockStatus.blockedUntil?.toLocaleString() || 'Permanente'}\n` +
                `📝 Razón: ${reason}`;

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

            user.blockStatus = {
                isBlocked: false,
                reason: null,
                blockedAt: null,
                blockedUntil: null,
                blockType: null
            };

            await user.save();

            adminBot.sendMessage(msg.chat.id, 
                `✅ Usuario ${username} desbloqueado correctamente`, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error en comando unblock:', error);
            adminBot.sendMessage(msg.chat.id, '❌ Error al desbloquear usuario');
        }
    }
};

// Procesar comandos administrativos
adminBot.on('message', (msg) => {
    if (msg.from.id.toString() !== TELEGRAM_CONFIG.adminId) {
        console.log('Intento de acceso no autorizado al bot admin:', msg.from);
        return;
    }

    const parts = msg.text.split(' ');
    const command = parts[0];
    const args = parts.slice(1);

    if (adminCommands[command]) {
        adminCommands[command](msg, args);
    }
});

// Agregar comando para ver intentos de ataque
adminBot.onText(/\/security/, async (msg) => {
    if (msg.from.id.toString() !== TELEGRAM_CONFIG.adminId) return;

    const blockedList = Array.from(securityConfig.blockedUsers.entries())
        .map(([userId, data]) => {
            const timeLeft = Math.ceil((data.expires - Date.now()) / 60000);
            return `👤 *Usuario:* ${userId}\n` +
                   `⏰ Bloqueado hace: ${Math.floor((Date.now() - data.blockedAt) / 60000)}min\n` +
                   `⌛ Tiempo restante: ${timeLeft}min\n`;
        }).join('\n');

    const mensaje = `🛡️ *Reporte de Seguridad*\n\n` +
        `📊 Usuarios bloqueados: ${securityConfig.blockedUsers.size}\n\n` +
        (blockedList || 'No hay usuarios bloqueados');

    adminBot.sendMessage(msg.chat.id, mensaje, {
        parse_mode: 'Markdown'
    });
});

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

module.exports = {
    TELEGRAM_CONFIG,
    adminBot: initBot(), // Exportar la instancia única
    enviarLiveEncontrada
}; 