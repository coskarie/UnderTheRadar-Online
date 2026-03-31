const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 방 데이터 저장소
const rooms = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    let currentRoom = null;
    let userName = "";

    // 1. 방 입장
    socket.on('joinRoom', (data) => {
        const { roomCode, name } = data;
        currentRoom = roomCode;
        userName = name;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], 
                spectators: [], 
                gameState: 'LOBBY',
                phraseCount: 0,
                turn: null
            };
        }

        rooms[roomCode].spectators.push({ id: socket.id, name: userName });
        updateRoomInfo(roomCode);
        io.to(roomCode).emit('systemMsg', `${userName}님이 입장하셨습니다.`);
    });

    // 2. 역할 변경
    socket.on('changeRole', (role) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room.gameState !== 'LOBBY') return;

        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (role === 'player') {
            if (room.players.length < 2) {
                room.players.push({ 
                    id: socket.id, 
                    name: userName, 
                    isReady: false, 
                    units: [], 
                    placed: false 
                });
            } else {
                socket.emit('systemMsg', '플레이어 자리가 꽉 찼습니다.');
                room.spectators.push({ id: socket.id, name: userName });
            }
        } else {
            room.spectators.push({ id: socket.id, name: userName });
        }
        updateRoomInfo(currentRoom);
    });

    // 3. 준비 완료 토글
    socket.on('toggleReady', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'LOBBY') return;
        const p = room.players.find(p => p.id === socket.id);
        if (p) {
            p.isReady = !p.isReady;
            updateRoomInfo(currentRoom);
        }
    });

    // 4. 게임 시작
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (room && room.players.length === 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLACING';
            io.to(currentRoom).emit('startPlacing');
            updateRoomInfo(currentRoom);
        }
    });

    // 5. 배치 확정
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        if (p) {
            p.units = units;
            p.placed = true;
        }

        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false);

            if (prevState === 'PLACING') {
                room.turn = room.players[Math.floor(Math.random() * 2)].id;
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
            } else {
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
            }
            updateRoomInfo(currentRoom);
        }
    });

    // 6. 공격
    socket.on('attack', (index) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const opponent = room.players.find(p => p.id !== socket.id);
        let hitResult = false;

        opponent.units.forEach(unit => {
            if (unit.cells.includes(index)) {
                if (!unit.hitCells) unit.hitCells = [];
                if (!unit.hitCells.includes(index)) {
                    unit.hitCells.push(index);
                    unit.isHit = true;
                }
                hitResult = true;
            }
        });

        if (hitResult) {
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: true });
            const allDestroyed = opponent.units.every(u => u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            if (allDestroyed) {
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            }
        } else {
            room.turn = opponent.id;
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: false, nextTurn: room.turn });
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving');
            }
        }
    });

    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;
        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.turn = null;
        room.players.forEach(p => { p.isReady = false; p.units = []; p.placed = false; });
        io.to(currentRoom).emit('rematchStarted');
        updateRoomInfo(currentRoom);
    });

    socket.on('sendChat', (msg) => {
        if (currentRoom) io.to(currentRoom).emit('receiveChat', { name: userName, msg });
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].players = rooms[currentRoom].players.filter(p => p.id !== socket.id);
            rooms[currentRoom].spectators = rooms[currentRoom].spectators.filter(s => s.id !== socket.id);
            updateRoomInfo(currentRoom);
        }
    });

    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) io.to(roomCode).emit('roomData', rooms[roomCode]);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));