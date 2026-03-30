try {
    require('dotenv').config();
} catch (e) {
    console.log("dotenv not found. Relying on native environment variables.");
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ==========================================
// SECURITY: HTTP Headers & Rate Limiting
// ==========================================

// Helmet secures Express apps by setting various HTTP headers.
// Content Security Policy is disabled here to allow the inline scripts/styles in your current index.html.
// In a production app with separate JS/CSS files, you should enable and configure CSP.
app.use(helmet({
    contentSecurityPolicy: false, 
}));

// Basic Rate Limiting to prevent HTTP DDoS/Brute Force
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again later."
});
app.use('/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Railway stability
app.get('/health', (req, res) => res.status(200).send('OK'));

// ==========================================
// SECURITY: Database Connection Configuration
// ==========================================
// Removed hardcoded sensitive passwords. Always rely on Environment Variables.
const dbConfig = {
    host: process.env.MYSQLHOST || 'mysql.railway.internal',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD, 
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;
if (dbConfig.password) {
    try {
        pool = mysql.createPool(dbConfig);
        console.log("Database pool configured.");
        
        // Test connection and initialize tables
        pool.getConnection().then(async (conn) => {
            console.log("Successfully connected to MySQL database!");
            try {
                await conn.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        user_id VARCHAR(255) PRIMARY KEY,
                        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                    )
                `);
                await conn.query(`
                    CREATE TABLE IF NOT EXISTS calls (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        caller_id VARCHAR(255),
                        receiver_id VARCHAR(255),
                        status VARCHAR(50) DEFAULT 'active',
                        start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                        end_time DATETIME
                    )
                `);
                console.log("Database tables verified/created successfully.");
            } catch (tableError) {
                console.error("Error creating tables:", tableError);
            } finally {
                conn.release();
            }
        }).catch(err => {
            console.error("Failed to connect to MySQL database on startup:", err);
        });
    } catch (e) {
        console.error("Failed to initialize MySQL pool:", e);
    }
} else {
    console.warn("WARNING: MYSQLPASSWORD is not set. Database connections will likely fail.");
}

// ==========================================
// SECURITY: WebSockets Configuration
// ==========================================
const io = new Server(server, {
    cors: { 
        // Best practice: Restrict origin to your actual frontend domain instead of "*"
        origin: process.env.ALLOWED_ORIGIN || "https://vcall-production.up.railway.app/", 
        methods: ["GET", "POST"]
    },
    // Prevent large payloads (default is 1MB, WebRTC signaling is very small)
    maxHttpBufferSize: 5e4 // 50 KB limit
});

// In-memory state
let waitingQueue = []; 
const activeCalls = new Map(); 
const userMap = new Map(); 

// SECURITY Helper: Input Validation
const isValidUserId = (id) => typeof id === 'string' && /^\d{9}$/.test(id);
const isValidCallId = (id) => typeof id === 'number' && id > 0 && Number.isInteger(id);

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // SECURITY: Socket Event Rate Limiting (Prevent flood attacks)
    let eventCount = 0;
    let lastReset = Date.now();
    const RATE_LIMIT_WINDOW = 1000; // 1 second
    const MAX_EVENTS_PER_WINDOW = 30; // Max 30 socket events per second per user

    socket.use((packet, next) => {
        const now = Date.now();
        if (now - lastReset > RATE_LIMIT_WINDOW) {
            eventCount = 0;
            lastReset = now;
        }
        eventCount++;
        if (eventCount > MAX_EVENTS_PER_WINDOW) {
            console.warn(`[SECURITY] Rate limit exceeded by socket: ${socket.id}`);
            return next(new Error('Rate limit exceeded. Disconnecting.'));
        }
        next();
    });

    socket.on("error", (err) => {
        if (err && err.message === 'Rate limit exceeded. Disconnecting.') {
            socket.disconnect();
        }
    });

    // 1. Register User
    socket.on('register', async (callback) => {
        if (typeof callback !== 'function') return;

        const userId = Math.floor(100000000 + Math.random() * 900000000).toString();
        userMap.set(socket.id, userId);
        
        try {
            if (pool) {
                // Prepared statements automatically sanitize SQL inputs
                await pool.execute(
                    "INSERT INTO users (user_id) VALUES (?)",
                    [userId]
                );
            }
            callback({ success: true, user_id: userId });
        } catch (error) {
            console.error("DB Error on register:", error);
            // SECURITY: Never leak database error details to the client
            callback({ success: false, error: 'Internal server error' });
        }
    });

    // 2. Re-authenticate returning user
    socket.on('auth', (userId) => {
        // SECURITY: Validate userId format
        if (!isValidUserId(userId)) {
            return console.warn(`[SECURITY] Invalid auth userId attempt: ${userId}`);
        }

        userMap.set(socket.id, userId);
        if (pool) {
            pool.execute("UPDATE users SET last_seen = NOW() WHERE user_id = ?", [userId])
                .catch((err) => console.error("DB Error on auth update:", err));
        }
    });

    // 3. Start Matchmaking (Queue)
    socket.on('start_search', async () => {
        const userId = userMap.get(socket.id);
        if (!userId) return;

        // If someone is waiting in the queue, match them
        if (waitingQueue.length > 0) {
            const partnerSocket = waitingQueue.shift(); 
            
            // Ensure partner is still connected and isn't ourselves
            if (partnerSocket.id !== socket.id && io.sockets.sockets.get(partnerSocket.id)) {
                const partnerUserId = userMap.get(partnerSocket.id);
                
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

                activeCalls.set(socket.id, partnerSocket.id);
                activeCalls.set(partnerSocket.id, socket.id);

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

    // 5. Instant WebRTC Signaling
    socket.on('signal', (data) => {
        // SECURITY: Ensure data exists and doesn't exceed reasonable boundaries
        if (!data || typeof data !== 'object') return;

        const partnerId = activeCalls.get(socket.id);
        if (partnerId && io.sockets.sockets.get(partnerId)) {
            io.to(partnerId).emit('signal', data);
        }
    });

    // 6. End Call
    socket.on('end_call', async (callId) => {
        // SECURITY: Validate callId is a valid number to prevent SQL injection or type errors
        if (callId !== null && !isValidCallId(callId)) return;

        const partnerId = activeCalls.get(socket.id);
        
        if (partnerId) {
            io.to(partnerId).emit('partner_left'); 
            activeCalls.delete(partnerId);
        }
        activeCalls.delete(socket.id);

        if (pool && callId) {
            pool.execute("UPDATE calls SET status = 'ended', end_time = NOW() WHERE id = ?", [callId])
                .catch(err => console.error("DB Error on end_call:", err));
        }
    });

    // 7. Handle Disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
        
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
