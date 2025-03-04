const mongoose = require('mongoose');
require('dotenv').config();

// Configuración de conexiones (usando variables de entorno de Render)
const MONGODB_URI = `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@${process.env.MONGODB_CLUSTER}/${process.env.MONGODB_DB}?retryWrites=true&w=majority&appName=AlemanChecker`;

// Opciones de conexión actualizadas
const MONGODB_OPTIONS = {
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
    retryReads: true
};

async function conectarDB() {
    try {
        console.log('🔄 Intentando conectar a MongoDB...');
        
        // Construir URI con verificación
        const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@${process.env.MONGODB_CLUSTER}/${process.env.MONGODB_DB}`;
        
        console.log('📡 Conectando a:', uri.replace(/\/\/.*:.*@/, '//<credentials>@'));
        
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 5000,
            retryWrites: true,
            retryReads: true
        });
        
        console.log('✅ Conectado a MongoDB Atlas');
        return true;
    } catch (error) {
        console.error('❌ Error conectando a MongoDB:', error.message);
        return false;
    }
}

// Esquema de Usuario
const userSchema = new mongoose.Schema({
    username: String,
    password: String,
    key: String,
    keyUsed: Boolean,
    createdAt: Date,
    isAdmin: Boolean,
    lastLogin: Date,
    subscription: {
        startDate: Date,
        endDate: Date,
        daysValidity: Number,
        status: String
    },
    blockStatus: {
        isBlocked: { type: Boolean, default: false },
        reason: String,
        blockedAt: Date,
        blockedUntil: Date,
        blockType: {
            type: String,
            enum: ['24h', '48h', 'week', 'permanent']
        }
    },
    forceClose: {
        type: Boolean,
        default: false
    }
});

// Esquema de Key
const keySchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true
    },
    daysValidity: {
        type: Number,
        required: true,
        default: 30
    },
    used: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: true
    },
    // Agregar información del admin
    createdBy: {
        adminId: String,        // ID de Telegram del admin
        adminUsername: String,  // @username del admin
        adminName: String      // Nombre del admin
    }
});

// Métodos de Key
keySchema.methods.isValid = function() {
    return !this.used && new Date() < this.expiresAt;
};

keySchema.methods.markAsUsed = function(username) {
    this.used = true;
    return this.save();
};

keySchema.methods.getRemainingDays = function() {
    const now = new Date();
    const diffTime = this.expiresAt - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

// Agregar este método al userSchema
userSchema.methods.checkBlockStatus = function() {
    if (!this.blockStatus?.isBlocked) {
        return { blocked: false };
    }

    const now = new Date();
    // Si es bloqueo permanente
    if (this.blockStatus.blockType === 'permanent') {
        return {
            blocked: true,
            permanent: true,
            reason: this.blockStatus.reason,
            message: '🚫 Bloqueo permanente'
        };
    }

    // Si tiene fecha de expiración
    if (this.blockStatus.blockedUntil) {
        if (now < this.blockStatus.blockedUntil) {
            const timeLeft = Math.ceil((this.blockStatus.blockedUntil - now) / (1000 * 60 * 60));
            return {
                blocked: true,
                permanent: false,
                reason: this.blockStatus.reason,
                expiresAt: this.blockStatus.blockedUntil,
                timeLeft: timeLeft,
                message: `🚫 Bloqueado por ${timeLeft} horas más`
            };
        } else {
            // Si el bloqueo expiró, lo limpiamos
            this.blockStatus.isBlocked = false;
            this.save();
            return { blocked: false };
        }
    }

    return { blocked: false };
};

// Crear schema para estadísticas
const StatsSchema = new mongoose.Schema({
    activeUsers: [String],
    totalChecks: Number,
    lives: Number,
    lastUpdate: Date,
    serverStatus: {
        memory: Number,
        cpu: Number,
        uptime: Number
    }
});

const Stats = mongoose.model('Stats', StatsSchema);

// Esquema de SecurityBlock para manejar bloqueos
const SecurityBlockSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true  // Para búsquedas más rápidas
    },
    username: {
        type: String,
        index: true
    },
    reason: {
        type: String,
        required: true,
        enum: ['Intento de ataque', 'Spam', 'Comportamiento sospechoso', 'Manual']
    },
    blockedAt: {
        type: Date,
        default: Date.now
    },
    expires: {
        type: Date,
        required: true
    },
    attackType: {
        type: String,
        enum: ['SQL Injection', 'Command Injection', 'Spam', 'Unauthorized', 'Other']
    },
    attempts: {
        type: Number,
        default: 1
    },
    ip: String,
    details: {
        lastAttempt: Date,
        attemptedCommands: [String],
        notes: String
    }
});

// Métodos del esquema
SecurityBlockSchema.methods = {
    // Verificar si el bloqueo está activo
    isActive() {
        return this.expires > new Date();
    },
    
    // Extender el bloqueo
    extend(hours) {
        this.expires = new Date(this.expires.getTime() + (hours * 60 * 60 * 1000));
    },
    
    // Incrementar intentos
    incrementAttempts() {
        this.attempts += 1;
        this.lastAttempt = new Date();
    }
};

// Índices para mejor rendimiento
SecurityBlockSchema.index({ expires: 1 });
SecurityBlockSchema.index({ userId: 1, expires: 1 });

const SecurityBlock = mongoose.model('SecurityBlock', SecurityBlockSchema);

// Definir los modelos en alemanChecker
const User = mongoose.model('User', userSchema, 'users');
const Key = mongoose.model('Key', keySchema, 'keys');

// Funciones para Keys
async function generateKey(days) {
    try {
        console.log('🔄 Bot Telegram: Generando nueva key...');
        const crypto = require('crypto');
        const key = crypto.randomBytes(16).toString('hex').toUpperCase();
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);

        const newKey = new Key({
            key: key,
            daysValidity: days,
            expiresAt: expiresAt,
            createdAt: new Date()
        });

        console.log('💾 Intentando guardar key en MongoDB...');
        const savedKey = await newKey.save();
        console.log('✅ Key guardada exitosamente:', savedKey);

        return savedKey;
    } catch (error) {
        console.error('❌ Error generando key:', error);
        throw error;
    }
}

async function getLastKeys(limit = 5) {
    try {
        console.log('🔄 Obteniendo últimas keys de Atlas...');
        
        const keys = await Key.aggregate([
            { $sort: { createdAt: -1 } },
            { $limit: limit },
            // Lookup para obtener info del usuario que usa la key
            {
                $lookup: {
                    from: 'users',
                    let: { keyValue: '$key' },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ['$key', '$$keyValue'] }
                            }
                        },
                        {
                            $project: {
                                username: 1,
                                _id: 0
                            }
                        }
                    ],
                    as: 'userInfo'
                }
            },
            {
                $project: {
                    key: 1,
                    createdAt: 1,
                    expiresAt: 1,
                    daysValidity: 1,
                    createdBy: 1,
                    estado: {
                        $cond: {
                            if: '$used',
                            then: 'Utilizada',
                            else: 'Disponible'
                        }
                    },
                    usedBy: {
                        $cond: {
                            if: { $gt: [{ $size: '$userInfo' }, 0] },
                            then: { $arrayElemAt: ['$userInfo.username', 0] },
                            else: 'Sin usar'
                        }
                    }
                }
            }
        ]);

        console.log(`✅ Últimas ${limit} keys obtenidas de Atlas`);
        return keys;
    } catch (error) {
        console.error('❌ Error obteniendo últimas keys:', error);
        return [];
    }
}

async function getAllKeys() {
    try {
        console.log('🔄 Obteniendo todas las keys de Atlas...');
        
        // Asegurar conexión a Atlas
        if (mongoose.connection.readyState !== 1) {
            await conectarDB();
        }

        // Obtener solo las keys de Atlas
        const keys = await Key.find({})
            .sort({ createdAt: -1 })
            .lean(); // Para mejor rendimiento

        console.log(`✅ Keys encontradas en Atlas: ${keys.length}`);
        return keys;
    } catch (error) {
        console.error('❌ Error obteniendo keys:', error);
        return [];
    }
}

async function deleteKey(key) {
    return await Key.deleteOne({ key: key });
}

// Funciones para Usuarios
async function getActiveUsers() {
    return await User.find({ 
        'subscription.status': 'active',
        'blockStatus.isBlocked': false 
    });
}

async function getAllUsers() {
    return await User.find({}).sort({ createdAt: -1 });
}

// Funciones de Bloqueo
async function blockUser(username, duration, reason) {
    try {
        console.log(`🚫 Intentando bloquear usuario: ${username}`);
        const blockUntil = new Date();
        
        switch (duration) {
            case '24h': blockUntil.setHours(blockUntil.getHours() + 24); break;
            case '48h': blockUntil.setHours(blockUntil.getHours() + 48); break;
            case 'week': blockUntil.setDate(blockUntil.getDate() + 7); break;
            case 'permanent': blockUntil.setFullYear(blockUntil.getFullYear() + 100); break;
            default: throw new Error('Duración inválida');
        }

        const result = await User.updateOne(
            { username },
            {
                $set: {
                    'blockStatus.isBlocked': true,
                    'blockStatus.reason': reason,
                    'blockStatus.blockedAt': new Date(),
                    'blockStatus.blockedUntil': blockUntil,
                    'blockStatus.blockType': duration
                }
            }
        );

        return result.modifiedCount > 0;
    } catch (error) {
        console.error('❌ Error bloqueando usuario:', error);
        throw error;
    }
}

async function unblockUser(username) {
    try {
        console.log(`🔓 Intentando desbloquear usuario: ${username}`);
        
        // Actualizar y limpiar completamente el estado de bloqueo
        const result = await User.updateOne(
            { username },
            { 
                $set: {
                    'blockStatus.isBlocked': false,
                    'blockStatus.reason': null,
                    'blockStatus.blockedAt': null,
                    'blockStatus.blockedUntil': null,
                    'blockStatus.blockType': null,
                    forceClose: false
                }
            }
        );

        if (result.modifiedCount > 0) {
            console.log('✅ Usuario desbloqueado completamente');
            return true;
        } else {
            // Intentar actualizar solo forceClose si el primer intento falló
            const forceCloseResult = await User.updateOne(
                { username },
                { $set: { forceClose: false } }
            );
            
            if (forceCloseResult.modifiedCount > 0) {
                console.log('✅ ForceClose actualizado correctamente');
                return true;
            }
            
            console.log('❌ No se pudo actualizar el usuario');
            return false;
        }
    } catch (error) {
        console.error('❌ Error desbloqueando usuario:', error);
        throw error;
    }
}

// Funciones de Estadísticas
async function getStats() {
    try {
        console.log('📊 Bot Telegram: Obteniendo stats...');
        const stats = await Stats.findOne({});
        
        if (!stats) {
            return {
                message: '📊 Estadísticas del Sistema\n\n' +
                        '👥 Usuarios Activos: 0\n' +
                        '📈 Total Checks: 0\n' +
                        '✅ Lives Encontradas: 0\n\n' +
                        '🖥️ Estado del Servidor:\n' +
                        '- Memoria: 0MB\n' +
                        '- CPU: 0%\n' +
                        '- Uptime: 0h 0m\n\n' +
                        `⏰ Última Actualización: ${new Date().toLocaleString()}`
            };
        }

        // Formatear números
        const formatNumber = num => num?.toLocaleString() || 0;
        
        // Formatear memoria
        const formatMemory = bytes => {
            const mb = Math.round(bytes / 1024 / 1024);
            return `${mb}MB`;
        };

        // Formatear uptime
        const formatUptime = seconds => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        };

        return {
            message: '📊 Estadísticas del Sistema\n\n' +
                    `👥 Usuarios Activos: ${stats.activeUsers?.length || 0}\n` +
                    `📈 Total Checks: ${formatNumber(stats.totalChecks)}\n` +
                    `✅ Lives Encontradas: ${formatNumber(stats.lives)}\n\n` +
                    '🖥️ Estado del Servidor:\n' +
                    `- Memoria: ${formatMemory(stats.serverStatus?.memory)}\n` +
                    `- CPU: ${Math.round(stats.serverStatus?.cpu || 0)}%\n` +
                    `- Uptime: ${formatUptime(stats.serverStatus?.uptime)}\n\n` +
                    `⏰ Última Actualización: ${stats.lastUpdate?.toLocaleString()}`
        };

    } catch (error) {
        console.error('❌ Error obteniendo stats:', error);
        return {
            message: '❌ Error obteniendo estadísticas'
        };
    }
}

async function updateStats(data) {
    try {
        console.log('📊 Bot Telegram: Actualizando stats...');
        
        await Stats.findOneAndUpdate(
            {}, // Documento único
            {
                activeUsers: Array.from(global.activeUsers.keys()),
                totalChecks: data.totalChecks,
                lives: data.lives,
                lastUpdate: new Date(),
                serverStatus: {
                    memory: process.memoryUsage().heapUsed,
                    cpu: require('os').loadavg()[0],
                    uptime: process.uptime()
                }
            },
            { upsert: true }
        );

        console.log('✅ Stats actualizadas correctamente');
    } catch (error) {
        console.error('❌ Error actualizando stats:', error);
        throw error;
    }
}

// Agregar SecurityLog a los modelos exportados
const SecurityLog = require('../models/SecurityLog');

module.exports = {
    conectarDB,
    User,
    Key,
    Stats,
    SecurityBlock,
    generateKey,
    getLastKeys,
    getAllKeys,
    deleteKey,
    getActiveUsers,
    getAllUsers,
    blockUser,
    unblockUser,
    getStats,
    updateStats,
    SecurityLog
}; 