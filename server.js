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
                // 🚨 [추가됨] 최초 시작 시 양측 연료 8통 세팅
                room.players.forEach(p => { p.maxFuel = 8; p.fuel = 8; });
                
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                
                // 🚨 [추가됨] 선공자에게 턴을 넘기며 첫 유지비 차감 (방금 파트1에서 만든 함수 사용!)
                passTurn(room, room.turn);
                
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

    // 6. 특수 능력 판정 공격 로직
    socket.on('attack', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const { index, type } = data;
        const attacker = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);

        // 🔫 SNIPE (저격) 로직 검증
        if (type === 'SNIPE') {
            if (attacker.fuel < 1) return socket.emit('systemMsg', "저격 실패: 연료가 1 필요합니다.");
            
            const targetX = index % 20;
            const isBlocked = attacker.units.some(u => {
                if (u.type !== 'ㅜ') return false;
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                return isAlive && u.cells.some(c => c % 20 === targetX); // 같은 열에 살아있는지
            });
            if (isBlocked) return socket.emit('systemMsg', "저격 실패: 아군 ㅜ 블럭에 시야가 가려져 있습니다.");
            
            attacker.fuel -= 1; 
            socket.emit('updateFuel', { current: attacker.fuel, max: attacker.maxFuel });
        }

        let hitResult = false;
        let hitType = null;
        let shieldBlocked = false;

        opponent.units.forEach(unit => {
            if (unit.cells.includes(index)) {
                // 🛡️ ㅜ 블럭 방패 판정 (cells[1]이 볼록 튀어나온 전면부임)
                if (unit.type === 'ㅜ') {
                    const shieldIdx = unit.cells[1];
                    const shieldDestroyed = unit.hitCells && unit.hitCells.includes(shieldIdx);
                    if (index !== shieldIdx && !shieldDestroyed) {
                        shieldBlocked = true; // 전면부가 멀쩡한데 후방을 때렸으므로 무효화!
                        return; 
                    }
                }

                if (!unit.hitCells) unit.hitCells = [];
                if (!unit.hitCells.includes(index)) {
                    unit.hitCells.push(index);
                    unit.isHit = true;
                }
                hitResult = true;
                hitType = unit.type;

                // 💥 ㄷ 블럭 전손 패널티 (연료통 파괴)
                if (unit.type === 'ㄷ' && unit.hitCells.length === unit.cells.length) {
                    opponent.maxFuel = Math.max(0, opponent.maxFuel - 2);
                    attacker.maxFuel += 1;
                    io.to(currentRoom).emit('systemMsg', "⚠️ 제조창(ㄷ) 완전 파괴! [공격자 최대연료 +1 / 피해자 -2]");
                }
                
                // 📦 강철 상자 피격 이벤트
                if (unit.type === '📦') {
                    opponent.fuel += 2;
                    io.to(currentRoom).emit('systemMsg', "📦 강철 상자 피격! 상대방이 연료를 2 획득했습니다.");
                    io.to(opponent.id).emit('updateFuel', { current: opponent.fuel, max: opponent.maxFuel });
                }
            }
        });

        if (shieldBlocked) {
            socket.emit('systemMsg', "🛡️ 상대의 ㅜ 블럭 전면 장갑에 막혀 데미지를 주지 못했습니다!");
            hitResult = false; // 빗나감 처리
        }

        if (hitResult) {
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: true });
            
            // 📦 상자는 전멸 판정에서 제외!
            const allDestroyed = opponent.units.every(u => u.type === '📦' || u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            if (allDestroyed) {
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            } else {
                // 🛡️ ㅜ 블럭 타격 시 추가 턴 뺏김
                if (hitType === 'ㅜ') {
                    io.to(currentRoom).emit('systemMsg', "🛡️ ㅜ 블럭 타격: 단단한 장갑에 튕겨 추가 공격 기회가 소멸되었습니다!");
                    passTurn(room, opponent.id);
                }
            }
        } else {
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: false, nextTurn: opponent.id }); // UI 갱신용
            passTurn(room, opponent.id); // 턴 넘기며 유지비 차감

            // 5프레이즈 본대 재배치
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving');
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 본대 유닛을 재배치하세요.");
            }
        }
    });

    // 🚨 기동함선(1x1) 이동 엔진
    socket.on('move1x1', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;
        
        const { from, to } = data;
        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);
        
        if (player.fuel < 2) return socket.emit('systemMsg', "기동 실패: 연료가 2 필요합니다.");

        // 🚶 8방향 인접 거리 수학적 검증
        const fromX = from % 20, fromY = Math.floor(from / 20);
        const toX = to % 20, toY = Math.floor(to / 20);
        if (Math.abs(fromX - toX) > 1 || Math.abs(fromY - toY) > 1) {
            return socket.emit('systemMsg', "기동 실패: 인접한 1칸(대각선 포함 8방향)으로만 이동 가능합니다.");
        }

        const unit = player.units.find(u => u.type === '1x1' && u.cells.includes(from) && !u.isHit);
        if (!unit) return;

        // 서버쪽 이동 처리 및 연료 차감
        unit.cells = [to];
        player.fuel -= 2;
        socket.emit('updateFuel', { current: player.fuel, max: player.maxFuel });
        socket.emit('syncMovedUnit', { oldIdx: from, newIdx: to }); // 클라이언트 시각 동기화
        socket.emit('systemMsg', "🏃 1x1 기동함선 이동 완료. (-2⛽)");

        // 📡 레이더(L) 발각 판정 로직
        const isSpotted = opponent.units.some(u => {
            if (u.type !== 'L') return false;
            const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
            return isAlive && u.cells.some(c => c % 20 === toX); // 같은 X열 진입 시
        });

        if (isSpotted) {
            io.to(currentRoom).emit('systemMsg', "📡 [레이더 경보] 적 기동함선의 움직임이 포착되었습니다!");
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

    // 🚨 [신규] 유지비 차감 및 턴 넘기기 유틸 함수
    function passTurn(room, nextTurnId) {
        room.turn = nextTurnId;
        const nextPlayer = room.players.find(p => p.id === nextTurnId);
        if (nextPlayer) {
            // 📦 강철 상자를 제외하고 살아있는 함선 수 계산
            const aliveShips = nextPlayer.units.filter(u => u.type !== '📦' && u.cells.length > (u.hitCells ? u.hitCells.length : 0)).length;
            nextPlayer.fuel -= aliveShips; 
            if (nextPlayer.fuel < 0) nextPlayer.fuel = 0; 
            
            io.to(nextTurnId).emit('updateFuel', { current: nextPlayer.fuel, max: nextPlayer.maxFuel });
            io.to(nextTurnId).emit('systemMsg', `🔥 내 턴 시작! (유지비: ⛽ -${aliveShips})`);
        }
    }

    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomData', rooms[roomCode]);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tactical Engine Active on port ${PORT}`));
