try {
    require('dotenv').config();
} catch (e) {
    console.log("dotenv not found. Relying on native environment variables (e.g., Railway).");
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Serve the frontend HTML files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Railway stability
app.get('/health', (req, res) => res.status(200).send('OK'));

// Database Connection (Railway provides these environment variables)
const dbConfig = {
    host: process.env.MYSQLHOST || 'mysql.railway.internal',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'ksvizXCvRfxOpKhaDUgjemkdNAnFausZ',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;
try {
    pool = mysql.createPool(dbConfig);
    console.log("Database pool configured.");
} catch (e) {
    console.error("Failed to connect to MySQL", e);
}

// In-memory queue and active users mapping
let waitingQueue = []; // Users waiting for a match
const activeCalls = new Map(); // Map socket.id to their partner's socket.id
const userMap = new Map(); // Map socket.id to their DB user_id

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // 1. Register User
    socket.on('register', async (callback) => {
        const userId = Math.floor(100000000 + Math.random() * 900000000).toString();
        userMap.set(socket.id, userId);
        
        try {
            if (pool) {
                await pool.execute(
                    "INSERT INTO users (user_id) VALUES (?)",
                    [userId]
                );
            }
            callback({ success: true, user_id: userId });
        } catch (error) {
            console.error("DB Error on register:", error);
            callback({ success: false, error: 'Database error' });
        }
    });

    // 2. Re-authenticate returning user
    socket.on('auth', (userId) => {
        userMap.set(socket.id, userId);
        if (pool) {
            // Added .catch to prevent unhandled promise rejections crashing the server
            pool.execute("UPDATE users SET last_seen = NOW() WHERE user_id = ?", [userId])
                .catch((err) => console.error("DB Error on auth update:", err));
        }
    });

    // 3. Start Matchmaking (Queue)
    socket.on('start_search', async () => {
        const userId = userMap.get(socket.id);
        if (!userId) return;

        // If someone is waiting in the queue, match them!
        if (waitingQueue.length > 0) {
            const partnerSocket = waitingQueue.shift(); // Get the first person waiting
            
            // Ensure partner is still connected and isn't ourselves
            if (partnerSocket.id !== socket.id && io.sockets.sockets.get(partnerSocket.id)) {
                const partnerUserId = userMap.get(partnerSocket.id);
                
                // Save Call to Database
                let callId = null;
                if (pool) {
                    try {
                        const [result] = await pool.execute(
                            "INSERT INTO calls (caller_id, receiver_id) VALUES (?, ?)",
                            [partnerUserId, userId]
                        );
                        callId = result.insertId;
                    } catch(e) { 
                        console.error("DB Error on start_search:", e); 
                    }
                }

                // Map them to each other
                activeCalls.set(socket.id, partnerSocket.id);
                activeCalls.set(partnerSocket.id, socket.id);

                // Tell both users they found a match
                partnerSocket.emit('match_found', { 
                    call_id: callId, 
                    partner_id: userId, 
                    is_caller: true 
                });
                
                socket.emit('match_found', { 
                    call_id: callId, 
                    partner_id: partnerUserId, 
                    is_caller: false 
                });
                
                return;
            }
        }

        // If no one is waiting, join the queue
        if (!waitingQueue.includes(socket)) {
            waitingQueue.push(socket);
        }
    });

    // 4. Leave Queue (Cancel Search)
    socket.on('cancel_search', () => {
        waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    });

    // 5. Instant WebRTC Signaling (No Database needed here!)
    socket.on('signal', (data) => {
        const partnerId = activeCalls.get(socket.id);
        if (partnerId && io.sockets.sockets.get(partnerId)) {
            // Forward the exact signal payload to the partner instantly
            io.to(partnerId).emit('signal', data);
        }
    });

    // 6. End Call
    socket.on('end_call', async (callId) => {
        const partnerId = activeCalls.get(socket.id);
        
        if (partnerId) {
            io.to(partnerId).emit('partner_left'); // Tell partner
            activeCalls.delete(partnerId);
        }
        activeCalls.delete(socket.id);

        if (pool && callId) {
            // Added .catch to prevent crash on end call
            pool.execute("UPDATE calls SET status = 'ended', end_time = NOW() WHERE id = ?", [callId])
                .catch(err => console.error("DB Error on end_call:", err));
        }
    });

    // 7. Handle Disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        // Remove from queue
        waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
        
        // Notify partner if in a call
        const partnerId = activeCalls.get(socket.id);
        if (partnerId) {
            io.to(partnerId).emit('partner_left');
            activeCalls.delete(partnerId);
            activeCalls.delete(socket.id);
        }
        userMap.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;

// Binding specifically to '0.0.0.0' is required for Railway deployments to stay alive
server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
