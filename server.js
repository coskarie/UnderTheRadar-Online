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
        const attackIndex = index;
        const targetIndex = 199 - attackIndex; 

        const attacker = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);

        const attackX = attackIndex % 20; 
        const targetX = targetIndex % 20;
        const targetY = Math.floor(targetIndex / 20);

        // 🔫 SNIPE (저격) 로직 검증
        if (type === 'SNIPE') {
            if (attacker.fuel < 1) return socket.emit('systemMsg', "저격 실패: 연료가 1 필요합니다.");
            
            // 🚨 저격수의 Y좌표를 기억할 변수
            let sniperY = -1; 

            // 1. 저격 사선 검증 및 저격수 Y좌표 추출
            const hasLineOfSight = attacker.units.some(u => {
                if (u.type !== 'I') return false; 
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                const hasSight = isAlive && u.cells.some(c => c % 20 === attackX);
                
                // 사선이 맞다면, 이 저격수의 Y좌표를 저장해둡니다. (I블럭은 가로라 아무 셀이나 Y가 같음)
                if (hasSight) {
                    sniperY = Math.floor(u.cells[0] / 20); 
                }
                return hasSight;
            });
            
            if (!hasLineOfSight) return socket.emit('systemMsg', "저격 실패: 아군 ㅡ(I) 블럭의 사선(X열)을 벗어났습니다!");

            // 2. 아군 탱커(T) 오사 방지 검증 (🚨 Y좌표 앞뒤 판정 완벽 적용)
            const isBlockedByAlly = attacker.units.some(u => {
                if (u.type !== 'T') return false; 
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                
                // 조건 1: T블럭이 같은 사선(X열)에 있는가?
                const sameX = u.cells.some(c => c % 20 === attackX); 
                
                // 조건 2: T블럭이 저격수보다 '앞쪽(Y값이 작음)'에 있는가?
                // T블럭의 셀 중 하나라도 저격수(sniperY)보다 Y값이 작으면 사선을 가린 것!
                const isTFrontOfSniper = u.cells.some(c => Math.floor(c / 20) < sniperY);

                return isAlive && sameX && isTFrontOfSniper; 
            });

            if (isBlockedByAlly) return socket.emit('systemMsg', "저격 실패: 아군 ㅜ(T) 블럭에 시야가 가려져 있습니다.");
            
            attacker.fuel -= 1; 
            socket.emit('updateFuel', { current: attacker.fuel, max: attacker.maxFuel });
        }

        // ... (아래 쉴드 및 타격 판정 로직은 기존과 동일하므로 생략 없이 그대로 유지)
        let hitResult = false;
        let hitType = null;
        let shieldBlocked = false;

        opponent.units.forEach(u => {
            if (u.type === 'T') {
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                if (isAlive) {
                    const tXs = u.cells.map(c => c % 20);
                    const tYs = u.cells.map(c => Math.floor(c / 20));
                    const minX = Math.min(...tXs);
                    const maxX = Math.max(...tXs);
                    const frontY = Math.min(...tYs); 

                    if (targetX >= minX && targetX <= maxX && targetY > frontY && !u.cells.includes(targetIndex)) {
                        shieldBlocked = true;
                    }
                }
            }
        });

        if (shieldBlocked) {
            socket.emit('systemMsg', "🛡️ 상대의 ㅜ(T) 블럭 후방 보호 영역에 막혀 빗나갔습니다!");
        } else {
            opponent.units.forEach(unit => {
                if (unit.cells.includes(targetIndex)) {
                    if (!unit.hitCells) unit.hitCells = [];
                    if (!unit.hitCells.includes(targetIndex)) {
                        unit.hitCells.push(targetIndex);
                        unit.isHit = true;
                    }
                    hitResult = true;
                    hitType = unit.type;

                    if (unit.type === 'ㄷ' && unit.hitCells.length === unit.cells.length) {
                        opponent.maxFuel = Math.max(0, opponent.maxFuel - 2);
                        attacker.maxFuel += 1;
                        io.to(currentRoom).emit('systemMsg', "⚠️ 제조창(ㄷ) 완전 파괴! [공격자 최대연료 +1 / 피해자 -2]");
                    }
                    
                    if (unit.type === '📦') {
                        // 🚨 즉시 지급이 아니라 '보너스 통장'에 적립해둠
                        opponent.bonusFuel = (opponent.bonusFuel || 0) + 2;
                        io.to(currentRoom).emit('systemMsg', "📦 강철 상자 피격! 다음 턴 시작 시 상대방에게 보너스 연료가 +2 지급됩니다.");
                    }
                }
            });
        }

        if (hitResult) {
            const allDestroyed = opponent.units.every(u => u.type === '📦' || u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            
            if (allDestroyed) {
                // 게임 끝났을 때
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true });
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            } else {
                if (hitType === 'T' && type !== 'SNIPE') {
                    // 🛡️ [일반 공격]으로 T블럭을 맞췄을 때 -> 턴 넘어감!
                    passTurn(room, opponent.id);
                    // 🚨 nextTurn: opponent.id 를 확실하게 담아서 보냄
                    io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true, nextTurn: opponent.id });
                    io.to(currentRoom).emit('systemMsg', "🛡️ ㅜ(T) 블럭 타격: 단단한 장갑에 튕겨 추가 공격 기회가 소멸되었습니다!");
                } else {
                    // 🎯 일반 함선을 맞췄거나, [저격]으로 맞췄을 때 -> 턴 유지!
                    if (hitType === 'T' && type === 'SNIPE') {
                        io.to(currentRoom).emit('systemMsg', "🛡️ ㅜ(T) 블럭 타격! (저격 능력이므로 턴이 유지됩니다.)");
                    }
                    // 🚨 nextTurn: socket.id (내 턴 유지) 를 확실하게 담아서 보냄
                    io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: true, nextTurn: socket.id });
                }
            }
        } else {
            // ✅ 수정: 저격(SNIPE)이 빗나가거나 방패에 막혔을 때 턴 유지!
            if (type === 'SNIPE') {
                // nextTurn을 내 id(socket.id)로 보내어 클라이언트 화면의 턴을 내 턴으로 유지
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, blocked: shieldBlocked, nextTurn: socket.id });
                socket.emit('systemMsg', "🔫 저격 완료! 추가 액션을 진행하세요.");
                // passTurn 호출 안 함!
            } else {
                room.phraseCount++;
                io.to(currentRoom).emit('attackResult', { attacker: socket.id, attackIndex, targetIndex, hit: false, blocked: shieldBlocked, nextTurn: opponent.id });
                passTurn(room, opponent.id); // 일반 공격이 빗나갔을 때만 턴 넘김

                // 프레이즈 체크는 일반 턴이 넘어갈 때만 카운트되도록 조정
                if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                    room.gameState = 'MOVING';
                    io.to(currentRoom).emit('startMoving');
                    io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 본대 유닛을 재배치하세요.");
                }
            }
        }
    }); // socket.on('attack') 끝

    // 9. 기동함선(1x1) 이동 엔진 (🚨 대면 모드 레이더 업그레이드)
    socket.on('move1x1', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;
        
        const { from, to } = data;
        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id);
        
        if (player.fuel < 2) return socket.emit('systemMsg', "기동 실패: 연료가 2 필요합니다.");

        const fromX = from % 20, fromY = Math.floor(from / 20);
        const toX = to % 20, toY = Math.floor(to / 20);
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

        // 📡 레이더(L) 발각 판정 (내 toX는 상대방 입장에서는 19 - toX 열에 해당함!)
        const isSpotted = opponent.units.some(u => {
            if (u.type !== 'L') return false;
            const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
            return isAlive && u.cells.some(c => c % 20 === (19 - toX));
        });

        if (isSpotted) {
            io.to(currentRoom).emit('systemMsg', "📡 [레이더 경보] 적 기동함선의 움직임이 포착되었습니다!");
        }
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

    // 🚨 실수로 날아갔던 함수 부활! 
    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomData', rooms[roomCode]);
        }
    }
}); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tactical Engine Active on port ${PORT}`));
