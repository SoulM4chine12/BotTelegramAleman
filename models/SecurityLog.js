const mongoose = require('mongoose');

const securityLogSchema = new mongoose.Schema({
    username: String,
    userId: Number,
    command: String,
    timestamp: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('SecurityLog', securityLogSchema); 