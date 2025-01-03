bot.command('unblock', async (ctx) => {
    try {
        // Verificar si es admin
        if (!ctx.from.isAdmin) {
            return ctx.reply('❌ Solo administradores pueden usar este comando');
        }

        const username = ctx.message.text.split(' ')[1];
        if (!username) {
            return ctx.reply('❌ Especifica el username');
        }

        // Desbloquear usuario usando updateOne directamente
        const result = await User.updateOne(
            { username },
            {
                $set: {
                    forceClose: false,
                    'blockStatus.isBlocked': false
                },
                $unset: {
                    'blockStatus.reason': "",
                    'blockStatus.blockedAt': "",
                    'blockStatus.blockedUntil': "",
                    'blockStatus.blockType': ""
                }
            }
        );

        if (result.modifiedCount > 0) {
            ctx.reply(`✅ Usuario ${username} desbloqueado correctamente`);
        } else {
            ctx.reply('❌ Usuario no encontrado o ya estaba desbloqueado');
        }

    } catch (error) {
        console.error('Error en comando unblock:', error);
        ctx.reply('❌ Error al procesar el comando');
    }
}); 