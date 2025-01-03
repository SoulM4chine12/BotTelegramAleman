const mongoose = require('mongoose');

// Configuración de conexiones
const MONGODB_URI = process.env.NODE_ENV === 'production' 
    ? process.env.MONGODB_URI || 'mongodb://alemanApp:ALEMAN1988@172.26.71.242:27017/alemanChecker?authSource=alemanChecker'
    : 'mongodb://alemanApp:ALEMAN1988@127.0.0.1:27017/alemanChecker?authSource=alemanChecker';

// Agregamos retry y timeout options
const MONGODB_OPTIONS = {
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
    retryReads: true
};

// Función para conectar a MongoDB con reintentos
async function conectarDB() {
    try {
        console.log('🔄 Intentando conectar a MongoDB...');
        await mongoose.connect(MONGODB_URI, MONGODB_OPTIONS);
        console.log('✅ Conectado a MongoDB:', process.env.NODE_ENV === 'production' ? 'Producción' : 'Local');
        return true;
    } catch (error) {
        console.error('❌ Error conectando a MongoDB:', error);
        console.log('🔍 URI de conexión:', MONGODB_URI.replace(/\/\/.*:.*@/, '//<usuario>:<contraseña>@'));
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

// Schema para bloqueos de seguridad
const SecurityBlockSchema = new mongoose.Schema({
    userId: String,
    username: String,
    reason: String,
    blockedAt: Date,
    expires: Date,
    attackType: String,
    attempts: Number,
    ip: String
});

const SecurityBlock = mongoose.model('SecurityBlock', SecurityBlockSchema);

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

// Definir los modelos en alemanChecker
const User = mongoose.model('User', userSchema, 'users');
const Key = mongoose.model('Key', keySchema, 'keys');

module.exports = {
    User,
    Key,
    Stats,
    SecurityBlock,
    conectarDB
}; 