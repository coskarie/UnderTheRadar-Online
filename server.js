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

    // 2. 역할 변경 (플레이어 <-> 관전자)
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

    // 3. 준비 완료 버튼 토글
    socket.on('toggleReady', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'LOBBY') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            updateRoomInfo(currentRoom);
        }
    });

    // 4. 게임 시작 버튼
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room) return;
        
        if (room.players.length === 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLACING';
            io.to(currentRoom).emit('startPlacing');
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', '모든 플레이어가 준비되어야 시작할 수 있습니다.');
        }
    });

    // 5. 배치 및 전술 기동 확정 로직 (🚨 백엔드 자물쇠 추가됨)
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        
        // 🔒 배치나 이동 단계가 아닐 때 억지로 신호를 보내면 차단!
        if (!room || (room.gameState !== 'PLACING' && room.gameState !== 'MOVING')) return;
        
        const player = room.players.find(p => p.id === socket.id);
        
        if (player) {
            player.units = units;
            player.placed = true;
        }

        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false);

            if (prevState === 'PLACING') {
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전투 시작! 선공을 확인하세요.");
            } else {
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전술 기동 완료! 전투를 재개합니다.");
            }
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', "상대방의 작전 완료를 기다리는 중입니다...");
        }
    });

    // 6. 공격 로직
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
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 피격되지 않은 유닛을 재배치하세요.");
            }
        }
    });

    // 7. 게임 종료 및 로비 초기화 로직
    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;

        // 1. 방 상태를 맨 처음(LOBBY)으로 되돌림
        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.turn = null;

        // 🚨 2. [핵심] 기존 플레이어들의 멱살을 잡고 관전자 명단으로 강제 이동!
        room.players.forEach(p => {
            room.spectators.push({ id: p.id, name: p.name });
        });
        
        // 3. 플레이어 명단을 텅 비워서 진정한 '초기 상태'로 만듦
        room.players = [];

        // 4. 모두에게 화면(로컬) 지우라고 명령하고, 바뀐 관전자 명단을 쏴줌
        io.to(currentRoom).emit('rematchStarted');
        updateRoomInfo(currentRoom);
        io.to(currentRoom).emit('systemMsg', "방이 초기화되었습니다. 다시 게임을 하려면 [플레이어로 가기]를 눌러주세요!");
    });

    socket.on('sendChat', (msg) => {
        if (currentRoom) io.to(currentRoom).emit('receiveChat', { name: userName, msg });
    });

    // 8. 접속 종료 로직 (🚨 탈주 닌자 방어선 추가됨)
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const wasPlayer = room.players.some(p => p.id === socket.id);
            
            // 명단에서 지우기
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            
            // 🔒 게임 도중에 플레이어가 나갔다면 방을 강제 초기화
            if (wasPlayer && (room.gameState === 'PLAYING' || room.gameState === 'PLACING' || room.gameState === 'MOVING')) {
                room.gameState = 'LOBBY';
                room.phraseCount = 0;
                room.turn = null;
                room.players.forEach(p => { 
                    p.isReady = false; 
                    p.placed = false; 
                    p.units = []; 
                });
                
                io.to(currentRoom).emit('systemMsg', "🚨 상대방의 연결이 끊겨 게임이 로비로 초기화되었습니다.");
                io.to(currentRoom).emit('rematchStarted'); // 클라이언트 화면 새로고침 명령
            }
            
            updateRoomInfo(currentRoom);
        }
    });

    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomData', rooms[roomCode]);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tactical Engine Active on port ${PORT}`));
