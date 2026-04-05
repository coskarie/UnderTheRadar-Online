const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 방 데이터 저장소
const rooms = {};

// 🚨 이미지, CSS 등 정적 파일을 유저에게 보낼 수 있도록 허용하는 통행증 코드!
app.use(express.static(__dirname)); 

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

    // 5. 배치 및 전술 기동 확정 로직
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        
        if (!room || (room.gameState !== 'PLACING' && room.gameState !== 'MOVING')) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (room.gameState === 'MOVING') {
            // ✅ 버그 수정 핵심 부분
            // 기존 코드: player.units = units → 서버가 기억하던 피격 기록이 싹 날아감
            // 수정 코드: 좌표(cells)만 바꾸고, 피격 기록(hitCells/isHit)은 그대로 보존
            const typePool = {};
            player.units.forEach(u => {
                if (!typePool[u.type]) typePool[u.type] = [];
                typePool[u.type].push(u);
            });

            units.forEach(newUnit => {
                const pool = typePool[newUnit.type];
                if (pool && pool.length > 0) {
                    pool.shift().cells = newUnit.cells; // 좌표만 덮어쓰기
                }
            });

            // 🚨 [CCTV] 기동 후 저격수 좌표 확인용 로그
            const sniper = player.units.find(u => u.type === 'I');
            console.log(`[기동 확정] ${player.name}의 저격수(I) 갱신된 좌표:`, sniper ? sniper.cells : "없음");

        } else {
            // PLACING 단계는 처음 배치라 피격 기록이 없으므로 기존대로 전체 교체해도 됨
            player.units = units;

            // 🚨 [CCTV] 최초 배치 저격수 좌표 확인용 로그
            const sniper = units.find(u => u.type === 'I');
            console.log(`[배치 확정] ${player.name}의 저격수(I) 좌표:`, sniper ? sniper.cells : "없음");
        }

        player.placed = true;

        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false);

            if (prevState === 'PLACING') {
                room.players.forEach(p => { p.maxFuel = 8; p.fuel = 8; });
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                passTurn(room, room.turn);
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전투 시작! 선공을 확인하세요.");

                // 🚨 게임 시작 시 1프레이즈로 표시!
                io.to(currentRoom).emit('updatePhrase', 1); 
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

    // 6. 특수 능력 판정 및 공격 로직 (140칸 최적화 Pro 버전)
    socket.on('attack', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const { index, type } = data;
        const attackIndex = index;
        // 🚨 140칸 시스템 거울 반전 공식 (0~139)
        const targetIndex = 139 - attackIndex; 

        const attacker = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);

        // 🚨 14칸 레이아웃 기준 좌표 계산 (0 ~ 13)
        const attackX = attackIndex % 14; 
        const targetX = targetIndex % 14;
        const targetY = Math.floor(targetIndex / 14);

        // ==========================================
        // [1] 저격(SNIPE) 특수 검증
        // ==========================================
        if (type === 'SNIPE') {
            if (attacker.fuel < 1) return socket.emit('systemMsg', "연료 부족: 저격 실패.");
            
            let sniperY = -1; 
            const hasLineOfSight = attacker.units.some(u => {
                if (u.type !== 'I') return false; 
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                const hasSight = isAlive && u.cells.some(c => c % 14 === attackX);
                if (hasSight) sniperY = Math.floor(u.cells[0] / 14); 
                return hasSight;
            });
            
            if (!hasLineOfSight) return socket.emit('systemMsg', "저격 실패: 해당 열에 아군 저격수(I)가 없습니다.");

            // 아군 T블럭 오사 방지 (저격수보다 앞에 있는 아군 방패 검증)
            const isBlockedByAlly = attacker.units.some(u => {
                if (u.type !== 'T') return false; 
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                const sameX = u.cells.some(c => c % 14 === attackX); 
                const isTFrontOfSniper = u.cells.some(c => Math.floor(c / 14) < sniperY);
                return isAlive && sameX && isTFrontOfSniper; 
            });

            if (isBlockedByAlly) return socket.emit('systemMsg', "저격 실패: 아군 방패(T)가 시야를 가립니다.");
            
            attacker.fuel -= 1; // 연료 차감
            socket.emit('updateFuel', { current: attacker.fuel, max: attacker.maxFuel });
        }

        // ==========================================
        // [2] 상대방 방어(T) 및 타격 판정
        // ==========================================
        let hitResult = false;
        let hitType = null;
        let shieldBlocked = false;

        // 상대방 T블럭 방패 판정
        opponent.units.forEach(u => {
            if (u.type === 'T') {
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                if (isAlive) {
                    const tXs = u.cells.map(c => c % 14);
                    const tYs = u.cells.map(c => Math.floor(c / 14));
                    const minX = Math.min(...tXs);
                    const maxX = Math.max(...tXs);
                    const frontY = Math.min(...tYs); // 방패의 최전방 Y좌표

                    // 사선에 걸리고, 방패보다 뒤쪽이며, 방패 본체 클릭이 아닐 때
                    if (targetX >= minX && targetX <= maxX && targetY > frontY && !u.cells.includes(targetIndex)) {
                        shieldBlocked = true;
                    }
                }
            }
        });

        // 타격 처리 로직 (막히지 않았을 때만 발동)
        if (!shieldBlocked) {
            opponent.units.forEach(unit => {
                if (unit.cells.includes(targetIndex)) {
                    if (!unit.hitCells) unit.hitCells = [];
                    if (!unit.hitCells.includes(targetIndex)) {
                        unit.hitCells.push(targetIndex);
                        unit.isHit = true;
                    }
                    hitResult = true;
                    hitType = unit.type;

                    // 특수 블럭(ㄷ, 📦) 파괴 효과
                    if (unit.type === 'ㄷ' && unit.hitCells.length === unit.cells.length) {
                        opponent.maxFuel = Math.max(0, opponent.maxFuel - 2);
                        attacker.maxFuel += 1;
                        io.to(currentRoom).emit('systemMsg', "⚠️ 제조창(ㄷ) 완파! [공격자 최대연료 +1 / 피해자 -2]");
                    }
                    if (unit.type === '📦') {
                        opponent.bonusFuel = (opponent.bonusFuel || 0) + 2;
                        io.to(currentRoom).emit('systemMsg', "📦 강철 상자 피격! 다음 턴 보너스 연료 +2 적립.");
                    }
                }
            });
        }

        // ==========================================
        // [3] 결과 전송 및 턴/프레이즈 계산
        // ==========================================
        if (shieldBlocked) {
            // 🛡️ 방패에 막혔을 때
            socket.emit('systemMsg', "🛡️ 상대의 T블럭 방패에 막혔습니다!");
            if (type === 'SNIPE') {
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, blocked: true, nextTurn: socket.id });
            } else {
                room.phraseCount++;
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, blocked: true, nextTurn: opponent.id });
                passTurn(room, opponent.id);
            }
        } 
        else if (hitResult) {
            // 💥 타격 성공했을 때
            const allDestroyed = opponent.units.every(u => u.type === '📦' || u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            
            if (allDestroyed) {
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true });
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
                return; // 게임 끝났으니 아래 로직 무시
            } 
            
            if (hitType === 'T' && type !== 'SNIPE') {
                passTurn(room, opponent.id);
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true, nextTurn: opponent.id });
                io.to(currentRoom).emit('systemMsg', "🛡️ T블럭 타격! 공격 기회가 소멸되었습니다.");
            } else {
                if (hitType === 'T' && type === 'SNIPE') {
                    io.to(currentRoom).emit('systemMsg', "🛡️ T블럭 타격! (저격 능력이므로 턴이 유지됩니다.)");
                }
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true, nextTurn: socket.id });
            }
        } 
        else {
            // 🌊 허공에 빗나갔을 때
            if (type === 'SNIPE') {
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, nextTurn: socket.id });
                socket.emit('systemMsg', "🔫 저격 빗나감! (턴 유지)");
            } else {
                room.phraseCount++;
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, nextTurn: opponent.id });
                passTurn(room, opponent.id);
            }
        }

        // ==========================================
        // [4] 공통: 프레이즈 갱신 및 재배치(MOVING) 체크
        // ==========================================
        // 저격이 아닌 일반 공격이 빗나가거나 막혔을 때만 프레이즈가 증가하므로, 그 조건을 확인
        if (type !== 'SNIPE' && (!hitResult || shieldBlocked)) {
            const currentPhrase = Math.floor(room.phraseCount / 2) + 1;
            io.to(currentRoom).emit('updatePhrase', currentPhrase);

            // 10번 빗나감 = 5왕복 = 5프레이즈 달성
            if (room.phraseCount > 0 && room.phraseCount % 10 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving');
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈(10턴) 도달! 본대 유닛을 재배치하세요.");
            }
        }
        updateRoomInfo(currentRoom);
    }); // socket.on('attack') 끝

    // 9. 기동함선(1x1) 이동 엔진 (🚨 대면 모드 레이더 업그레이드)
    socket.on('move1x1', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;
        
        const { from, to } = data;
        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);
        
        if (player.fuel < 2) return socket.emit('systemMsg', "기동 실패: 연료가 2 필요합니다.");

        // 🚨 가로 칸 수를 20에서 14로 수정
        const fromX = from % 14, fromY = Math.floor(from / 14);
        const toX = to % 14, toY = Math.floor(to / 14);
        if (Math.abs(fromX - toX) > 1 || Math.abs(fromY - toY) > 1) {
            return socket.emit('systemMsg', "기동 실패: 인접한 1칸(대각선 포함 8방향)으로만 이동 가능합니다.");
        }

        const unit = player.units.find(u => u.type === '1x1' && u.cells.includes(from) && !u.isHit);
        if (!unit) return;

        unit.cells = [to];
        player.fuel -= 2;
        socket.emit('updateFuel', { current: player.fuel, max: player.maxFuel });
        socket.emit('syncMovedUnit', { oldIdx: from, newIdx: to }); 
        socket.emit('systemMsg', "🏃 1x1 기동함선 이동 완료. (-2⛽)");

        // 📡 레이더(L) 발각 판정 (내 toX는 상대방 입장에서는 13 - toX 열에 해당함!)
        const isSpotted = opponent.units.some(u => {
            if (u.type !== 'L') return false;
            const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
            return isAlive && u.cells.some(c => c % 14 === (13 - toX));
        });

        if (isSpotted) {
            // 🚨 currentRoom(방 전체) ➡️ opponent.id(레이더 주인) 에게만 귓속말 전송!
            io.to(opponent.id).emit('systemMsg', "📡 [레이더 경보] 적 기동함선의 움직임이 포착되었습니다!");
        }
        updateRoomInfo(currentRoom);
    });

    // 7. 게임 종료 및 로비 초기화 로직
    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;

        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.turn = null;

        room.players.forEach(p => {
            room.spectators.push({ id: p.id, name: p.name });
        });
        
        room.players = [];

        io.to(currentRoom).emit('rematchStarted');
        updateRoomInfo(currentRoom);
        io.to(currentRoom).emit('systemMsg', "방이 초기화되었습니다. 다시 게임을 하려면 [플레이어로 가기]를 눌러주세요!");
    });

    socket.on('sendChat', (msg) => {
        if (currentRoom) io.to(currentRoom).emit('receiveChat', { name: userName, msg });
    });

    // 8. 접속 종료 로직
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            const wasPlayer = room.players.some(p => p.id === socket.id);
            
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            
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
                io.to(currentRoom).emit('rematchStarted'); 
            }
            
            updateRoomInfo(currentRoom);
        }
    });

    // 🚨 턴 넘기기 유틸 함수 (연료 마이너스 통장 탈출 및 상자 보너스 적용!)
    function passTurn(room, nextTurnId) {
        room.turn = nextTurnId;
        const nextPlayer = room.players.find(p => p.id === nextTurnId);
        
        if (nextPlayer) {
            const aliveShips = nextPlayer.units.filter(u => u.type !== '📦' && u.cells.length > (u.hitCells ? u.hitCells.length : 0)).length;
            
            // 🚨 1. 기본 연료 계산 (최대 연료 - 생존 함선 수)
            let baseFuel = nextPlayer.maxFuel - aliveShips; 
            if (baseFuel < 0) baseFuel = 0; 
            
            // 🚨 2. 보너스 통장에서 연료 꺼내기 (강철 상자 혜택)
            const bonus = nextPlayer.bonusFuel || 0;
            nextPlayer.fuel = baseFuel + bonus; // 기본 연료에 보너스 합산!
            nextPlayer.bonusFuel = 0; // 보너스 수령 후 통장 초기화 (먹튀 방지)

            // 🚨 3. 클라이언트에 갱신된 연료 정보 쏘기
            io.to(nextTurnId).emit('updateFuel', { current: nextPlayer.fuel, max: nextPlayer.maxFuel });
            
            // 🚨 4. 보너스 유무에 따라 시스템 메시지를 다르게 출력
            if (bonus > 0) {
                io.to(nextTurnId).emit('systemMsg', `🔥 내 턴 시작! (🎁상자 보너스 +${bonus} 합산됨! 현재 연료: ⛽ ${nextPlayer.fuel})`);
            } else {
                io.to(nextTurnId).emit('systemMsg', `🔥 내 턴 시작! (유지비 차감 후 연료: ⛽ ${nextPlayer.fuel})`);
            }
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
