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
                turnCount: 0,   // 🚨 턴 카운터 추가
                bonusBox: null, // 🚨 보급 상자 위치 (0~139) 추가
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

        const isPlayer1 = (player.id === room.players[0].id);

        // 🚨 [수정] 보급 상자 겹침 체크 로직 보완
        if (room.bonusBox !== null) {
            const overlapsWithBox = units.some(u => 
                u.cells.some(c => {
                    const absCell = isPlayer1 ? c : (139 - c);
                    return absCell === room.bonusBox;
                })
            );

            // 배치 단계에서만 엄격하게 막고, 기동 단계에서는 겹침 허용 (이미 상자 위에 있을 수 있으므로)
            if (room.gameState === 'PLACING' && overlapsWithBox) {
                return socket.emit('systemMsg', "⚠️ 보급 상자가 있는 칸에는 유닛을 배치할 수 없습니다.");
            }
        }

        if (room.gameState === 'MOVING') {
            // 🚨 유닛 상태 복원 및 덮어쓰기 로직 강화
            const oldUnits = JSON.parse(JSON.stringify(player.units));
            player.units = units;

            player.units.forEach(newU => {
                const oldU = oldUnits.find(u => u.type === newU.type);
                if (oldU) {
                    newU.hitCells = oldU.hitCells || [];
                    newU.isHit = oldU.isHit || false;
                    newU.destroyedTurn = oldU.destroyedTurn;
                }
            });
            console.log(`[CCTV] ${player.name} 본대 기동 확정 완료`);
        } else {
            player.units = units;
        }

        player.placed = true; 

        // 양쪽 모두 확정 시 상태 전환
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
            } else {
                // 기동 후 전투 재개
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전술 기동 완료! 전투를 재개합니다.");
            }
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', "상대방의 작전 완료를 기다리는 중입니다...");
            updateRoomInfo(currentRoom); 
        }
    });

    // 6. 특수 능력 판정 및 공격 로직 (140칸 최적화 Pro 버전)
    socket.on('attack', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const { index, type } = data;
        
        const attackIndex = index;
        const targetIndex = 139 - attackIndex;
        //const targetUnit = opponent.units.find(u => u.cells.includes(targetIndex));

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
        let bombTriggered = false; // 🚨 [신규] 폭발 블럭 발동 여부 확인용 플래그

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
                    // 🚨 [신규] 이미 맞은 칸인지 확인
                    const isNewHit = !(unit.hitCells && unit.hitCells.includes(targetIndex));

                    if (!unit.hitCells) unit.hitCells = [];
                    if (isNewHit) {
                        unit.hitCells.push(targetIndex);
                        unit.isHit = true;
                    }
                    hitResult = true;
                    hitType = unit.type;

                    // 🚨 [신규] 지뢰(💣) 폭발 조건: 새로운 타격이고, 그게 폭발 블럭일 때!
                    if (unit.type === '💣' && isNewHit) {
                        bombTriggered = true; 
                    }

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
                    // 1x1 파괴 시점 기록
                    if (unit.type === '1x1' && unit.hitCells.length === unit.cells.length) {
                        unit.destroyedTurn = room.turnCount || 0; // 파괴된 턴 수 저장
                        io.to(currentRoom).emit('systemMsg', `⚠️ 기동함선(1x1) 파괴됨! 제조창(ㄷ) 생존 시 10턴(5프레이즈) 후 자동 복구됩니다.`);
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
                room.bonusBox = null; // 🚨 [추가] 게임 끝나면 상자 소멸!
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

            // 🚨🚨 [신규 핵심 로직] 지뢰(💣) 폭발! 카운터 3x3 데미지 반사 🚨🚨
            if (bombTriggered) {
                io.to(currentRoom).emit('systemMsg', `🚨 경보! 지뢰(💣) 피격! 공격자 진영에 3x3 융단 폭격이 가해집니다!`);

                // 공격자의 진영 기준 좌표(attackIndex)를 중심으로 3x3 범위를 가져옴
                const explosionArea = get3x3Area(targetIndex);

                explosionArea.forEach(expIdx => {
                    let isHit = false;
                    
                    // 공격자의 유닛들을 확인하여 타격 판정 (내 살 깎아먹기)
                    attacker.units.forEach(u => {
                        if (u.cells.includes(expIdx)) {
                            isHit = true;
                            if (!u.hitCells) u.hitCells = [];
                            if (!u.hitCells.includes(expIdx)) {
                                u.hitCells.push(expIdx);
                                u.isHit = true;
                            }
                        }
                    });

                    // 9번의 카운터 폭격을 각각 전송!
                    // 상대방(opponent)이 나를 때린 것처럼 위장해서 신호를 쏘면 화면 동기화 완벽 해결!
                    io.to(currentRoom).emit('attackResult', {
                        attacker: opponent.id, 
                        attackIndex: (9 - Math.floor(expIdx / 14)) * 14 + (expIdx % 14), 
                        targetIndex: expIdx,
                        hit: isHit,
                        blocked: false,
                        isBomb: expIdx === targetIndex 
                    });
                });
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

            // ====================================================================
            // 🚨 [신규 추가] L블럭(레이더) 자동 탐색 시스템 (10, 20, 30... 프레이즈마다 1번씩 발동)
            // ====================================================================
            if (room.phraseCount > 0 && room.phraseCount % 2 === 0 && currentPhrase % 10 === 0) {
                room.players.forEach((player, pIndex) => {
                    const opponent = room.players[pIndex === 0 ? 1 : 0];

                    // 1. 내 L블럭이 존재하는지, 파괴되지 않았는지 확인
                    const radarUnit = player.units.find(u => u.type === 'L');
                    const isRadarAlive = radarUnit && radarUnit.cells.length > (radarUnit.hitCells ? radarUnit.hitCells.length : 0);

                    if (isRadarAlive) {
                        // 2. 140칸 중 랜덤한 센터 포인트 잡기
                        const centerIdx = Math.floor(Math.random() * 140);
                        const area = [];
                        const cx = centerIdx % 14;
                        const cy = Math.floor(centerIdx / 14);

                        // 3. 센터 포인트 기준 3x3 영역 계산
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const nx = cx + dx;
                                const ny = cy + dy;
                                // 14 x 10 격자 밖으로 삐져나가는거 방지
                                if (nx >= 0 && nx < 14 && ny >= 0 && ny < 10) {
                                    area.push(ny * 14 + nx);
                                }
                            }
                        }

                        // 4. 이 3x3 구역 안에 적 유닛이 있는지 스캔!
                        let foundEnemy = false;
                        opponent.units.forEach(oppUnit => {
                            // 파괴된 잔해는 무시하고, 살아있는 함선만 감지하도록
                            const isOppAlive = oppUnit.cells.length > (oppUnit.hitCells ? oppUnit.hitCells.length : 0);
                            
                            if (isOppAlive) {
                                oppUnit.cells.forEach(c => {
                                    // 🚨 핵심 버그 수정 완료 (거울 반전 동기화)
                                    // 내 시점의 레이더망(area)과 상대방 시점의 유닛 좌표(c)를 매칭하려면 무조건 139 - c 로 뒤집어야 합니다!
                                    if (area.includes(139 - c)) {
                                        foundEnemy = true;
                                    }
                                });
                            }
                        });

                        // 5. 결과를 L블럭의 주인(클라이언트)에게 발송!
                        const isP1 = (player.id === room.players[0].id);
                    const clientCenterIdx = isP1 ? centerIdx : (139 - centerIdx);
                    const clientArea = isP1 ? area : area.map(c => 139 - c);

                    io.to(player.id).emit('autoRadarResult', { 
                        centerIdx: clientCenterIdx, 
                        area: clientArea, 
                        foundEnemy 
                    });
                    }
                });
            }
        }
        updateRoomInfo(currentRoom);
    }); // socket.on('attack') 끝

    function get3x3Area(centerIdx) {
        const cX = centerIdx % 14;
        const cY = Math.floor(centerIdx / 14);
        let area = [];
        
        for(let dy = -1; dy <= 1; dy++) {
            for(let dx = -1; dx <= 1; dx++) {
                const nx = cX + dx;
                const ny = cY + dy;
                
                // 14x10 격자 밖으로 벗어난 좌표는 폭발에서 제외
                if(nx >= 0 && nx < 14 && ny >= 0 && ny < 10) {
                    area.push(ny * 14 + nx);
                }
            }
        }
        return area;
    }

    // 9. 기동함선(1x1) 이동 및 보급 상자 획득 엔진
    socket.on('move1x1', (data) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;
        
        const { from, to } = data;
        const player = room.players.find(p => p.id === socket.id);
        const opponent = room.players.find(p => p.id !== socket.id); // 상대방 정보
        const isPlayer1 = (player.id === room.players[0].id);

        if (player.fuel < 2) return socket.emit('systemMsg', "기동 실패: 연료가 2 필요합니다.");

        // 🚨 140칸 기준 반경 2칸 검증
        const fromX = from % 14, fromY = Math.floor(from / 14);
        const toX = to % 14, toY = Math.floor(to / 14);
        if (Math.abs(fromX - toX) > 2 || Math.abs(fromY - toY) > 2) {
            return socket.emit('systemMsg', "기동 실패: 반경 2칸 이내로만 이동 가능합니다.");
        }

        const unit = player.units.find(u => u.type === '1x1' && u.cells.includes(from) && !u.isHit);
        if (!unit) return;

        // 이동 처리
        unit.cells = [to];
        player.fuel -= 2;

        // 🚨 [신규] L블럭 레이더 포착 시스템 (뛰어넘는 궤적 스캔)
        if (opponent) {
            let radarCols = new Set();
            opponent.units.forEach(u => {
                const isAlive = u.cells.length > (u.hitCells ? u.hitCells.length : 0);
                if (u.type === 'L' && isAlive) {
                    u.cells.forEach(c => radarCols.add(c % 14));
                }
            });

            if (radarCols.size > 0) {
                // 내 이동 경로를 상대방 시점의 좌표로 변환
                const oppFrom = 139 - from;
                const oppTo = 139 - to;
                
                const oppFromX = oppFrom % 14;
                const oppToX = oppTo % 14;
                
                const minX = Math.min(oppFromX, oppToX);
                const maxX = Math.max(oppFromX, oppToX);

                let isDetected = false;
                for (let col of radarCols) {
                    if (col >= minX && col <= maxX) {
                        isDetected = true;
                        break;
                    }
                }

                if (isDetected) {
                    io.to(opponent.id).emit('radarDetected', { index: oppTo });
                    socket.emit('systemMsg', "⚠️ 경고: 적의 L블럭 레이더망을 통과하여 위치가 발각되었습니다!");
                }
            }
        }

        // 🎁 보급 상자 획득 판정
        const absoluteTo = isPlayer1 ? to : (139 - to);
        if (room.bonusBox !== null && absoluteTo === room.bonusBox) {
            player.fuel += 4; 
            room.bonusBox = null;
            io.to(currentRoom).emit('systemMsg', `🎊 ${player.name} 지휘관이 보급 상자를 확보했습니다! (연료 +4⛽)`);
        }

        socket.emit('updateFuel', { current: player.fuel, max: player.maxFuel });
        socket.emit('syncMovedUnit', { oldIdx: from, newIdx: to }); 
        socket.emit('systemMsg', "🏃 1x1 기동함선 이동 완료. (-2⛽)");

        updateRoomInfo(currentRoom); // 관전자 화면 갱신
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
        room.turnCount = (room.turnCount || 0) + 1; // 🚨 전체 턴 카운트 증가
        const nextPlayer = room.players.find(p => p.id === nextTurnId);
        
        // 🔧 [신규 추가] 제조창(ㄷ) 1x1 자동 재생성 시스템
        room.players.forEach(p => {
            const scout = p.units.find(u => u.type === '1x1');
            const factory = p.units.find(u => u.type === 'ㄷ');

            // 1. 1x1이 파괴되어 있고, 파괴된 시점이 기록되어 있는지 검증
            if (scout && scout.isHit && scout.destroyedTurn !== undefined) {
                
                // 2. 제조창(ㄷ)이 단 1칸이라도 살아있는지 검증
                const isFactoryAlive = factory && factory.cells.length > (factory.hitCells ? factory.hitCells.length : 0);
                
                // 3. 파괴된 지 10턴(5프레이즈)이 지났는지 검증
                if (isFactoryAlive && (room.turnCount - scout.destroyedTurn >= 10)) {
                    
                    // 4. ㄷ 블럭의 "안쪽" 좌표 수학적 계산 (가장 좌측 상단 기준 +1칸 이동한 위치)
                    let minX = 14, minY = 10;
                    factory.cells.forEach(c => {
                        const x = c % 14, y = Math.floor(c / 14);
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                    });
                    const insideIdx = (minY + 1) * 14 + (minX + 1); 

                    // 5. 1x1 부활 및 재배치
                    scout.cells = [insideIdx]; // ㄷ 안쪽으로 좌표 강제 지정
                    scout.hitCells = [];
                    scout.isHit = false; // 부활!
                    scout.destroyedTurn = undefined; // 기록 리셋

                    io.to(currentRoom).emit('systemMsg', `🔧 ${p.name} 지휘관의 제조창(ㄷ)이 가동되어 1x1 기동함선을 자동 복구했습니다!`);
                }
            }
        });

        // 🚨 [수정] 보급 상자 생성 로직: 상자가 없을 때만 카운터가 돌아갑니다!
        if (room.bonusBox === null || room.bonusBox === undefined) {
            room.boxTurnCount = (room.boxTurnCount || 0) + 1; // 상자 전용 타이머 째깍째깍
            
            if (room.boxTurnCount >= 7) {
                const occupiedCells = new Set();
                room.players.forEach(p => {
                    p.units.forEach(u => {
                        u.cells.forEach(c => {
                            // 플레이어 2의 좌표는 1번 기준으로 변환해서 체크
                            const cell = (p.id === room.players[0].id) ? c : (139 - c);
                            occupiedCells.add(cell);
                        });
                    });
                });

                // 빈 칸 찾기 (최대 100번 시도)
                let randomIdx;
                for(let i=0; i<100; i++) {
                    randomIdx = Math.floor(Math.random() * 140);
                    if (!occupiedCells.has(randomIdx)) {
                        room.bonusBox = randomIdx; // 보급 상자 위치 확정
                        room.boxTurnCount = 0;     // 🚨 상자가 생성되었으므로 타이머를 0으로 리셋 후 정지!
                        
                        io.to(Object.keys(room.spectators).concat(room.players.map(p=>p.id))).emit('systemMsg', "🎁 전장에 보급 상자가 투하되었습니다! (선점하세요!)");
                        break;
                    }
                }
            }
        }

        if (nextPlayer) {
            const aliveShips = nextPlayer.units.filter(u => u.type !== '📦' && u.type !== '💣' && u.cells.length > (u.hitCells ? u.hitCells.length : 0)).length;
            
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
