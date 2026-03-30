const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection (Uses Railway Environment Variables)
const pool = mysql.createPool({
    host: process.env.MYSQLHOST || 'localhost',
    user: process.env.MYSQLUSER || 'jmcstor1_admin',
    password: process.env.MYSQLPASSWORD || 'Ragaifun1@',
    database: process.env.MYSQLDATABASE || 'jmcstor1_vchat',
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// In-Memory State
let queue = [];
let activeCalls = new Map(); // call_id -> { caller, receiver }
let userSockets = new Map(); // user_id -> socket.id

io.on('connection', (socket) => {
    
    // 1. User Registration & Connection
    socket.on('register', async (requestedUserId, callback) => {
        let uid = requestedUserId;
        if (!uid) {
            uid = Math.floor(Math.random() * 900000000) + 100000000;
            uid = uid.toString();
        }
        socket.userId = uid;
        userSockets.set(uid, socket.id);

        try {
            await pool.query("INSERT IGNORE INTO users (user_id, name, gender) VALUES (?, 'Anonymous', 'unknown')", [uid]);
            await pool.query("UPDATE users SET last_seen = NOW() WHERE user_id = ?", [uid]);
        } catch (e) {
            console.error("DB Error on register:", e);
        }

        if (callback) callback({ user_id: uid });
    });

    // 2. Matchmaking Queue
    socket.on('join_queue', () => {
        if (!socket.userId) return;
        if (!queue.includes(socket.userId)) {
            queue.push(socket.userId);
        }
        checkQueue();
    });

    socket.on('leave_queue', () => {
        queue = queue.filter(id => id !== socket.userId);
    });

    // 3. WebRTC Signaling (Direct Peer-to-Peer Routing)
    socket.on('signal', (data) => {
        const { partner_id, type, payload } = data;
        const partnerSocketId = userSockets.get(partner_id);
        
        if (partnerSocketId) {
            io.to(partnerSocketId).emit('signal', { type, payload });
        }
    });

    // 4. End Call
    socket.on('end_call', async (data) => {
        const { call_id, partner_id } = data;
        const partnerSocketId = userSockets.get(partner_id);
        
        if (partnerSocketId) {
            io.to(partnerSocketId).emit('partner_left');
        }
        
        activeCalls.delete(call_id);
        try {
            await pool.query("UPDATE calls SET status = 'ended', end_time = NOW() WHERE call_id = ?", [call_id]);
        } catch (e) {}
    });

    // 5. Disconnect Handling
    socket.on('disconnect', async () => {
        if (!socket.userId) return;
        
        // Remove from queue
        queue = queue.filter(id => id !== socket.userId);
        
        // Find if user was in an active call
        const callEntry = [...activeCalls.entries()].find(([id, call]) => call.caller === socket.userId || call.receiver === socket.userId);
        
        if (callEntry) {
            const [call_id, call] = callEntry;
            const partnerId = call.caller === socket.userId ? call.receiver : call.caller;
            const partnerSocketId = userSockets.get(partnerId);
            
            if (partnerSocketId) {
                io.to(partnerSocketId).emit('partner_left');
            }
            
            activeCalls.delete(call_id);
            try {
                await pool.query("UPDATE calls SET status = 'ended', end_time = NOW() WHERE call_id = ?", [call_id]);
            } catch (e) {}
        }
        
        userSockets.delete(socket.userId);
    });
});

// Matchmaking Logic
async function checkQueue() {
    if (queue.length >= 2) {
        const callerId = queue.shift();
        const receiverId = queue.shift();
        const callId = `call_${Date.now()}_${Math.floor(Math.random()*1000)}`;

        const callerSocket = userSockets.get(callerId);
        const receiverSocket = userSockets.get(receiverId);

        if (callerSocket && receiverSocket) {
            activeCalls.set(callId, { caller: callerId, receiver: receiverId });

            // Notify both users
            io.to(callerSocket).emit('match_found', { call_id: callId, partner_id: receiverId, is_caller: true });
            io.to(receiverSocket).emit('match_found', { call_id: callId, partner_id: callerId, is_caller: false });

            // Log call to database
            try {
                await pool.query("INSERT INTO calls (call_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'connecting')", [callId, callerId, receiverId]);
            } catch (e) {
                console.error("DB Error on call start:", e);
            }
        } else {
            // If someone disconnected right before matching, put the other back
            if (callerSocket) queue.push(callerId);
            if (receiverSocket) queue.push(receiverId);
        }
    }
}

// Basic Admin API for Admin Panel
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Hardcoded simple admin check matching original PHP
    if (username === 'kariangna' && password === 'kariangna') {
        res.json({ success: true, token: 'admin-token-123' });
    } else {
        res.status(401).json({ success: false });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    if (req.headers.authorization !== 'admin-token-123') return res.status(401).json({error: 'Unauthorized'});
    try {
        const [users] = await pool.query("SELECT COUNT(*) as c FROM users");
        const [calls] = await pool.query("SELECT COUNT(*) as c FROM calls WHERE status = 'connecting' OR status = 'active'");
        res.json({
            total_users: users[0].c,
            active_calls: calls[0].c,
            users_in_queue: queue.length // Taken directly from memory, much faster!
        });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
