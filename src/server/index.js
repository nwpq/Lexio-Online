const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CORS 설정
app.use(cors());
app.use(express.json());

// 정적 파일 제공 (프로덕션)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
}

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ['websocket', 'polling']
});

// 게임 상태 관리
const rooms = new Map();
const players = new Map(); // socketId -> {id, name, roomId}

// 렉시오 게임 로직 (기존 코드에서 추출)
const SYMBOLS = {
  sun: { name: '해', color: 'text-yellow-500', bg: 'bg-yellow-100' },
  moon: { name: '달', color: 'text-blue-500', bg: 'bg-blue-100' },
  star: { name: '별', color: 'text-purple-500', bg: 'bg-purple-100' },
  cloud: { name: '구름', color: 'text-gray-500', bg: 'bg-gray-100' }
};

const NUMBER_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2];
const SYMBOL_ORDER = ['cloud', 'star', 'moon', 'sun'];

const HAND_RANKS = {
  SINGLE: 1,
  PAIR: 2,
  TRIPLE: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8
};

// 덱 생성
function createDeck(playerCount) {
  const deck = [];
  let maxNumber;
  
  switch (playerCount) {
    case 3: maxNumber = 9; break;
    case 4: maxNumber = 13; break;
    case 5: maxNumber = 15; break;
    default: maxNumber = 9;
  }
  
  Object.keys(SYMBOLS).forEach(symbol => {
    for (let num = 1; num <= maxNumber; num++) {
      deck.push({ symbol, number: num, id: `${symbol}-${num}` });
    }
  });
  
  return deck;
}

// 카드 비교
function compareCards(card1, card2) {
  const num1Index = NUMBER_ORDER.indexOf(card1.number);
  const num2Index = NUMBER_ORDER.indexOf(card2.number);
  
  if (num1Index !== num2Index) {
    return num1Index - num2Index;
  }
  
  return SYMBOL_ORDER.indexOf(card1.symbol) - SYMBOL_ORDER.indexOf(card2.symbol);
}

// 스트레이트 체크
function checkStraight(sortedCards) {
  const numbers = sortedCards.map(card => NUMBER_ORDER.indexOf(card.number));
  numbers.sort((a, b) => a - b);
  
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i + 1] - numbers[i] !== 1) {
      return false;
    }
  }
  
  return true;
}

// 패 분석
function analyzeHand(cards) {
  if (!cards || cards.length === 0) return null;
  
  if (cards.length === 1) {
    return { rank: HAND_RANKS.SINGLE, highCard: cards[0] };
  }
  
  if (cards.length === 2) {
    if (cards[0].number === cards[1].number) {
      const sorted = [...cards].sort(compareCards);
      return { rank: HAND_RANKS.PAIR, highCard: sorted[1], number: cards[0].number };
    }
    return null;
  }
  
  if (cards.length === 3) {
    if (cards.every(card => card.number === cards[0].number)) {
      return { rank: HAND_RANKS.TRIPLE, highCard: cards[0], number: cards[0].number };
    }
    return null;
  }
  
  if (cards.length === 5) {
    const sorted = [...cards].sort(compareCards);
    const isFlush = cards.every(card => card.symbol === cards[0].symbol);
    const isStraight = checkStraight(sorted);
    
    if (isFlush && isStraight) {
      return { rank: HAND_RANKS.STRAIGHT_FLUSH, highCard: sorted[4] };
    }
    
    const numberCounts = {};
    cards.forEach(card => {
      numberCounts[card.number] = (numberCounts[card.number] || 0) + 1;
    });
    
    const counts = Object.values(numberCounts);
    if (counts.includes(4)) {
      const fourNumber = Object.keys(numberCounts).find(num => numberCounts[num] === 4);
      return { rank: HAND_RANKS.FOUR_KIND, number: parseInt(fourNumber) };
    }
    
    if (counts.includes(3) && counts.includes(2)) {
      const threeNumber = Object.keys(numberCounts).find(num => numberCounts[num] === 3);
      return { rank: HAND_RANKS.FULL_HOUSE, number: parseInt(threeNumber) };
    }
    
    if (isFlush) {
      return { rank: HAND_RANKS.FLUSH, highCard: sorted[4] };
    }
    
    if (isStraight) {
      return { rank: HAND_RANKS.STRAIGHT, highCard: sorted[4] };
    }
  }
  
  return null;
}

// 패 비교
function compareHands(hand1, hand2) {
  if (!hand1 || !hand2) return 0;
  
  if (hand1.rank !== hand2.rank) {
    return hand1.rank - hand2.rank;
  }
  
  switch (hand1.rank) {
    case HAND_RANKS.SINGLE:
    case HAND_RANKS.FLUSH:
    case HAND_RANKS.STRAIGHT:
    case HAND_RANKS.STRAIGHT_FLUSH:
      return compareCards(hand1.highCard, hand2.highCard);
      
    case HAND_RANKS.PAIR:
    case HAND_RANKS.TRIPLE:
    case HAND_RANKS.FULL_HOUSE:
    case HAND_RANKS.FOUR_KIND:
      const num1Index = NUMBER_ORDER.indexOf(hand1.number);
      const num2Index = NUMBER_ORDER.indexOf(hand2.number);
      if (num1Index !== num2Index) {
        return num1Index - num2Index;
      }
      if (hand1.highCard && hand2.highCard) {
        return compareCards(hand1.highCard, hand2.highCard);
      }
      return 0;
      
    default:
      return 0;
  }
}

// 게임 생성
function createGame(roomId, playerCount) {
  return {
    id: roomId,
    players: [],
    gameState: 'waiting', // waiting, playing, finished
    playerCount,
    currentPlayer: 0,
    lastPlay: { cards: [], player: null, hand: null },
    gameLog: [],
    scores: {},
    passCount: 0,
    winner: null,
    round: 1
  };
}

// 게임 시작
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length < 3) return false;
  
  const deck = createDeck(room.players.length);
  const shuffledDeck = [...deck].sort(() => Math.random() - 0.5);
  
  const cardsPerPlayer = Math.floor(deck.length / room.players.length);
  
  // 카드 분배
  room.players.forEach((player, index) => {
    player.cards = shuffledDeck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer)
      .sort(compareCards);
  });
  
  // 구름3 가진 플레이어 찾기
  let startPlayer = 0;
  for (let i = 0; i < room.players.length; i++) {
    const hasCloud3 = room.players[i].cards.find(
      card => card.symbol === 'cloud' && card.number === 3
    );
    if (hasCloud3) {
      startPlayer = i;
      break;
    }
  }
  
  room.gameState = 'playing';
  room.currentPlayer = startPlayer;
  room.lastPlay = { cards: [], player: null, hand: null };
  room.passCount = 0;
  room.gameLog = [`${room.players[startPlayer].name}님이 구름3을 가져서 선플레이어입니다.`];
  room.winner = null;
  
  // 점수 초기화 (첫 라운드만)
  if (room.round === 1) {
    room.players.forEach((player, index) => {
      room.scores[index] = 100;
    });
  }
  
  return true;
}

// Socket.IO 이벤트 처리
io.on('connection', (socket) => {
  console.log('플레이어 연결:', socket.id);

  // 방 생성
  socket.on('createRoom', (data) => {
    const roomId = uuidv4().substring(0, 6).toUpperCase();
    const room = createGame(roomId, data.playerCount);
    
    const player = {
      id: socket.id,
      name: data.playerName,
      cards: [],
      isHost: true
    };
    
    room.players.push(player);
    rooms.set(roomId, room);
    players.set(socket.id, { id: socket.id, name: data.playerName, roomId });
    
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, room: sanitizeRoom(room, socket.id) });
  });

  // 방 참가
  socket.on('joinRoom', (data) => {
    const { roomId, playerName } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: '방을 찾을 수 없습니다.' });
      return;
    }
    
    if (room.players.length >= room.playerCount) {
      socket.emit('error', { message: '방이 가득 찼습니다.' });
      return;
    }
    
    if (room.gameState !== 'waiting') {
      socket.emit('error', { message: '게임이 이미 진행 중입니다.' });
      return;
    }
    
    const player = {
      id: socket.id,
      name: playerName,
      cards: [],
      isHost: false
    };
    
    room.players.push(player);
    players.set(socket.id, { id: socket.id, name: playerName, roomId });
    
    socket.join(roomId);
    io.to(roomId).emit('playerJoined', { 
      player: { id: player.id, name: player.name },
      room: sanitizeRoom(room, socket.id)
    });
  });

  // 게임 시작
  socket.on('startGame', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error', { message: '호스트만 게임을 시작할 수 있습니다.' });
      return;
    }
    
    if (startGame(playerData.roomId)) {
      io.to(playerData.roomId).emit('gameStarted', {
        room: sanitizeRoom(room)
      });
    }
  });

  // 카드 플레이
  socket.on('playCards', (data) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room || room.gameState !== 'playing') return;
    
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) {
      socket.emit('error', { message: '당신의 턴이 아닙니다.' });
      return;
    }
    
    const { selectedCards } = data;
    const hand = analyzeHand(selectedCards);
    
    if (!hand) {
      socket.emit('error', { message: '올바르지 않은 조합입니다.' });
      return;
    }
    
    // 조건 검사
    if (room.lastPlay.hand) {
      if (selectedCards.length !== room.lastPlay.cards.length) {
        socket.emit('error', { message: `${room.lastPlay.cards.length}장의 카드를 내야 합니다.` });
        return;
      }
      
      if (compareHands(hand, room.lastPlay.hand) <= 0) {
        socket.emit('error', { message: '더 높은 조합을 내야 합니다.' });
        return;
      }
    }
    
    // 카드 제거
    const player = room.players[playerIndex];
    player.cards = player.cards.filter(
      card => !selectedCards.find(selected => selected.id === card.id)
    );
    
    room.lastPlay = { cards: selectedCards, player: playerIndex, hand };
    room.passCount = 0;
    
    const handNames = {
      [HAND_RANKS.SINGLE]: '싱글',
      [HAND_RANKS.PAIR]: '페어',
      [HAND_RANKS.TRIPLE]: '트리플',
      [HAND_RANKS.STRAIGHT]: '스트레이트',
      [HAND_RANKS.FLUSH]: '플러쉬',
      [HAND_RANKS.FULL_HOUSE]: '풀하우스',
      [HAND_RANKS.FOUR_KIND]: '포카드',
      [HAND_RANKS.STRAIGHT_FLUSH]: '스트레이트플러쉬'
    };
    
    const logEntry = `${player.name}: ${handNames[hand.rank]} (${selectedCards.length}장)`;
    room.gameLog.push(logEntry);
    
    // 게임 종료 체크
    if (player.cards.length === 0) {
      endRound(room, playerIndex);
    } else {
      room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
    }
    
    io.to(playerData.roomId).emit('gameUpdated', {
      room: sanitizeRoom(room)
    });
  });

  // 패스
  socket.on('pass', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room || room.gameState !== 'playing') return;
    
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) return;
    
    if (room.lastPlay.cards.length === 0) {
      socket.emit('error', { message: '첫 턴에는 패스할 수 없습니다.' });
      return;
    }
    
    const player = room.players[playerIndex];
    room.gameLog.push(`${player.name}: 패스`);
    
    room.passCount++;
    
    if (room.passCount >= room.players.length - 1) {
      room.lastPlay = { cards: [], player: null, hand: null };
      room.passCount = 0;
      room.currentPlayer = room.lastPlay.player || room.currentPlayer;
      room.gameLog.push(`${room.players[room.currentPlayer]?.name || ''}님이 선이 되었습니다.`);
    } else {
      room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
    }
    
    io.to(playerData.roomId).emit('gameUpdated', {
      room: sanitizeRoom(room)
    });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('플레이어 연결 해제:', socket.id);
    const playerData = players.get(socket.id);
    
    if (playerData) {
      const room = rooms.get(playerData.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        
        if (room.players.length === 0) {
          rooms.delete(playerData.roomId);
        } else {
          // 호스트가 나간 경우 다음 플레이어를 호스트로
          if (!room.players.find(p => p.isHost)) {
            room.players[0].isHost = true;
          }
          
          socket.to(playerData.roomId).emit('playerLeft', {
            playerId: socket.id,
            room: sanitizeRoom(room)
          });
        }
      }
      
      players.delete(socket.id);
    }
  });
});

// 라운드 종료
function endRound(room, winnerIndex) {
  const winner = room.players[winnerIndex];
  room.winner = winner;
  
  // 점수 계산
  const cardCounts = room.players.map(player => {
    let count = player.cards.length;
    const twos = player.cards.filter(card => card.number === 2).length;
    return count * Math.pow(2, twos);
  });
  
  for (let i = 0; i < room.players.length; i++) {
    if (i !== winnerIndex) {
      const diff = cardCounts[i];
      room.scores[winnerIndex] += diff;
      room.scores[i] -= diff;
    }
  }
  
  room.gameState = 'finished';
  room.round++;
}

// 클라이언트에게 전송할 때 민감한 정보 제거
function sanitizeRoom(room, requesterId = null) {
  const sanitized = {
    ...room,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      cardCount: player.cards.length,
      cards: player.id === requesterId ? player.cards : [], // 본인 카드만 전송
      isHost: player.isHost
    }))
  };
  
  return sanitized;
}

// 프로덕션에서 React 앱 서빙
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});