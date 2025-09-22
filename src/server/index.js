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
const aiExecutionState = new Map(); // roomId -> { isExecuting: boolean, lastPlayerIndex: number }

// 렉시오 게임 로직
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

// 스트레이트 체크 (렉시오 규칙에 맞게 완전 재작성)
function checkStraight(cards, maxNumber = 15) {
  const numbers = cards.map(card => card.number).sort((a, b) => {
    const aIndex = NUMBER_ORDER.indexOf(a);
    const bIndex = NUMBER_ORDER.indexOf(b);
    return aIndex - bIndex;
  });
  
  // 가능한 스트레이트 패턴들 정의
  const possibleStraights = [];
  
  // 1. 특별한 스트레이트들 (우선 정의)
  possibleStraights.push([1, 2, 3, 4, 5]); // 1+2 조합 (최강)
  possibleStraights.push([2, 3, 4, 5, 6]); // 2만 포함 (두번째)
  
  // 2. 일반적인 연속 스트레이트 (3부터 시작)
  for (let start = 3; start <= maxNumber - 4; start++) {
    possibleStraights.push([start, start+1, start+2, start+3, start+4]);
  }
  
  // 3. 1이 끝에 오는 스트레이트들
  if (maxNumber >= 9) { // 3인용
    possibleStraights.push([6, 7, 8, 9, 1]);
  }
  if (maxNumber >= 13) { // 4인용  
    possibleStraights.push([10, 11, 12, 13, 1]);
  }
  if (maxNumber >= 15) { // 5인용
    possibleStraights.push([12, 13, 14, 15, 1]);
  }
  
  // 입력된 카드 숫자들이 가능한 스트레이트 중 하나와 일치하는지 확인
  for (const straight of possibleStraights) {
    if (straight.length === 5 && 
        straight.every(num => numbers.includes(num)) &&
        numbers.length === 5) {
      return true;
    }
  }
  
  return false;
}

// 스트레이트 타입 확인
function getStraightType(cards) {
  const hasOne = cards.some(card => card.number === 1);
  const hasTwo = cards.some(card => card.number === 2);
  
  if (hasOne && hasTwo) {
    return 'one_and_two'; // 1-2-3-4-5
  }
  
  if (hasTwo && !hasOne) {
    return 'two_only'; // 2-3-4-5-6
  }
  
  if (hasOne && !hasTwo) {
    const maxNormal = Math.max(...cards.filter(card => card.number !== 1).map(card => card.number));
    if (maxNormal >= 12) { // 12-13-14-15-1 패턴
      return 'one_at_end';
    }
  }
  
  return 'normal'; // 일반 스트레이트
}

// 스트레이트 비교를 위한 함수
function compareStraights(cards1, cards2) {
  const type1 = getStraightType(cards1);
  const type2 = getStraightType(cards2);
  
  // 타입별 우선순위
  const typeRanks = {
    'one_and_two': 4,    // 1-2-3-4-5 (최강)
    'two_only': 3,       // 2-3-4-5-6 (두번째)
    'one_at_end': 2,     // 12-13-14-15-1 (세번째)
    'normal': 1          // 일반 스트레이트 (가장 약함)
  };
  
  if (typeRanks[type1] !== typeRanks[type2]) {
    return typeRanks[type1] - typeRanks[type2];
  }
  
  // 같은 타입이면 최고 카드로 비교
  if (type1 === 'normal') {
    const max1 = Math.max(...cards1.map(card => NUMBER_ORDER.indexOf(card.number)));
    const max2 = Math.max(...cards2.map(card => NUMBER_ORDER.indexOf(card.number)));
    if (max1 !== max2) return max1 - max2;
  }
  
  // 문양으로 최종 비교
  const high1 = getStraightHighCard(cards1);
  const high2 = getStraightHighCard(cards2);
  return compareCards(high1, high2);
}

// 스트레이트의 최고 카드 찾기 (단순화)
function getStraightHighCard(cards) {
  const type = getStraightType(cards);
  
  switch (type) {
    case 'one_and_two':
      return cards.find(card => card.number === 2);
    case 'two_only':
      return cards.find(card => card.number === 2);
    case 'one_at_end':
      return cards.find(card => card.number === 1);
    default:
      const sortedCards = [...cards].sort(compareCards);
      return sortedCards[4];
  }
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
    
  if (cards.length === 5) {
    const sorted = [...cards].sort(compareCards);
    const isFlush = cards.every(card => card.symbol === cards[0].symbol);
    const playerCount = 5; // TODO: 실제 플레이어 수에 따라 조정
    const maxNumber = playerCount === 3 ? 9 : playerCount === 4 ? 13 : 15;
    const isStraight = checkStraight(cards, maxNumber);
    
    if (isFlush && isStraight) {
      return { rank: HAND_RANKS.STRAIGHT_FLUSH, highCard: getStraightHighCard(cards), cards: cards };
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
      return { rank: HAND_RANKS.STRAIGHT, highCard: getStraightHighCard(cards), cards: cards };
    }
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
      return compareCards(hand1.highCard, hand2.highCard);
      
    case HAND_RANKS.STRAIGHT:
    case HAND_RANKS.STRAIGHT_FLUSH:
      // 스트레이트는 특별한 비교 함수 사용
      if (hand1.cards && hand2.cards) {
        return compareStraights(hand1.cards, hand2.cards);
      }
      // cards 정보가 없으면 기본 비교
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
    round: 1,
    playerPlays: [] // 각 플레이어가 그 판에서 낸 카드들 기록
  };
}

// 게임 시작 (수정됨 - 나간 플레이어 완전 제거)
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length < 3) return false;
  
  // 새로운 라운드 시작 시 나간 플레이어 완전 제거
  if (room.round > 1) {
    const activePlayers = room.players.filter(p => !p.hasLeft);
    
    // 점수 재정렬
    const newScores = {};
    activePlayers.forEach((player, index) => {
      const oldIndex = room.players.findIndex(p => p.id === player.id);
      if (oldIndex !== -1 && room.scores[oldIndex] !== undefined) {
        newScores[index] = room.scores[oldIndex];
      } else {
        newScores[index] = 100; // 기본 점수
      }
    });
    
    room.players = activePlayers;
    room.scores = newScores;
  }
  
  const deck = createDeck(room.players.length);
  const shuffledDeck = [...deck].sort(() => Math.random() - 0.5);
  
  const cardsPerPlayer = Math.floor(deck.length / room.players.length);
  
  // 카드 분배
  room.players.forEach((player, index) => {
    player.cards = shuffledDeck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer)
      .sort(compareCards);
    player.hasLeft = false; // 라운드 시작 시 모든 플레이어 상태 초기화
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
  
  // 플레이어 플레이 기록 초기화
  room.playerPlays = room.players.map(() => []);
  
  // 점수 초기화 (첫 라운드만)
  if (room.round === 1) {
    room.players.forEach((player, index) => {
      room.scores[index] = 100;
    });
  }
  
  return true;
}

// AI 전략 시스템
function analyzeGameState(room, playerIndex) {
  const aiPlayer = room.players[playerIndex];
  const opponents = room.players.filter((p, i) => i !== playerIndex);
  
  return {
    myCardCount: aiPlayer.cards.length,
    opponentCardCounts: opponents.map(p => p.cards ? p.cards.length : 0),
    minOpponentCards: Math.min(...opponents.map(p => p.cards ? p.cards.length : 0)),
    totalCards: room.players.reduce((sum, p) => sum + (p.cards ? p.cards.length : 0), 0),
    gamePhase: aiPlayer.cards.length <= 3 ? 'endgame' : 
               aiPlayer.cards.length <= 7 ? 'midgame' : 'earlygame',
    isWinning: aiPlayer.cards.length <= Math.min(...opponents.map(p => p.cards ? p.cards.length : 0)),
    isBehind: aiPlayer.cards.length > Math.max(...opponents.map(p => p.cards ? p.cards.length : 0)),
    lastPlayStrength: room.lastPlay.hand ? room.lastPlay.hand.rank : 0
  };
}

function determineStrategy(room, playerIndex, gameState) {
  const aiPlayer = room.players[playerIndex];
  
  // 엔드게임 전략
  if (gameState.gamePhase === 'endgame') {
    return gameState.isWinning ? 'aggressive_finish' : 'desperate_catch_up';
  }
  
  // 미드게임 전략
  if (gameState.gamePhase === 'midgame') {
    if (gameState.isWinning) return 'maintain_lead';
    if (gameState.isBehind) return 'catch_up';
    return 'balanced';
  }
  
  // 얼리게임 전략
  const strongHands = countStrongHands(aiPlayer.cards);
  if (strongHands.fiveCard > 0) return 'power_play';
  if (strongHands.pairs + strongHands.triples > 2) return 'combo_setup';
  
  return 'conservative';
}

function countStrongHands(cards) {
  const numberGroups = {};
  const symbolGroups = {};
  
  cards.forEach(card => {
    if (!numberGroups[card.number]) numberGroups[card.number] = [];
    numberGroups[card.number].push(card);
    
    if (!symbolGroups[card.symbol]) symbolGroups[card.symbol] = [];
    symbolGroups[card.symbol].push(card);
  });
  
  const pairs = Object.values(numberGroups).filter(group => group.length === 2).length;
  const triples = Object.values(numberGroups).filter(group => group.length >= 3).length;
  const fours = Object.values(numberGroups).filter(group => group.length >= 4).length;
  
  let fiveCard = 0;
  Object.values(symbolGroups).forEach(group => {
    if (group.length >= 5) fiveCard++;
  });
  
  return { pairs, triples, fours, fiveCard };
}

// 전략적 오프닝 선택
function chooseStrategicOpening(cards, gameState, strategy, playerCount) {
  const sortedCards = [...cards].sort(compareCards);
  
  switch (strategy) {
    case 'power_play':
      const fiveCombos = findAllFiveCardCombos(cards);
      if (fiveCombos.length > 0) {
        const combo = fiveCombos[Math.floor(Math.random() * fiveCombos.length)];
        return { cards: combo, hand: analyzeHand(combo, playerCount) };
      }
      const triples = findAllTriples(cards);
      if (triples.length > 0) {
        const triple = triples[0];
        return { cards: triple, hand: analyzeHand(triple, playerCount) };
      }
      break;
      
    case 'combo_setup':
      const pairs = findAllPairs(cards);
      if (pairs.length > 0) {
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        return { cards: pair, hand: analyzeHand(pair, playerCount) };
      }
      break;
      
    case 'aggressive_finish':
      const allCombos = [
        ...findAllFiveCardCombos(cards),
        ...findAllTriples(cards),
        ...findAllPairs(cards)
      ];
      if (allCombos.length > 0) {
        const bestCombo = allCombos.sort((a, b) => b.length - a.length)[0];
        return { cards: bestCombo, hand: analyzeHand(bestCombo, playerCount) };
      }
      break;
      
    case 'conservative':
    default:
      if (Math.random() < 0.2) {
        const combos = [...findAllPairs(cards), ...findAllTriples(cards)];
        if (combos.length > 0) {
          const combo = combos[Math.floor(Math.random() * combos.length)];
          return { cards: combo, hand: analyzeHand(combo, playerCount) };
        }
      }
      return { cards: [sortedCards[0]], hand: analyzeHand([sortedCards[0]], playerCount) };
  }
  
  return { cards: [sortedCards[0]], hand: analyzeHand([sortedCards[0]], playerCount) };
}

// 전략적 의사결정
function makeStrategicDecision(room, playerIndex, gameState, strategy) {
  const aiPlayer = room.players[playerIndex];
  const possiblePlays = findPossibleAiPlays(aiPlayer.cards, room.lastPlay, room.players.length);
  
  if (possiblePlays.length === 0) {
    return { action: 'pass' };
  }
  
  switch (strategy) {
    case 'aggressive_finish':
      return { action: 'play', play: possiblePlays[0] };
      
    case 'desperate_catch_up':
      if (Math.random() < 0.8) {
        return { action: 'play', play: chooseBestPlay(possiblePlays, gameState) };
      }
      return { action: 'pass' };
      
    case 'maintain_lead':
      if (gameState.lastPlayStrength >= HAND_RANKS.FLUSH) {
        if (Math.random() < 0.7) return { action: 'pass' };
      }
      return { action: 'play', play: chooseBestPlay(possiblePlays, gameState) };
      
    case 'power_play':
      const strongPlays = possiblePlays.filter(p => p.hand.rank >= HAND_RANKS.FLUSH);
      if (strongPlays.length > 0 && Math.random() < 0.6) {
        return { action: 'play', play: strongPlays[0] };
      }
      if (Math.random() < 0.4) return { action: 'pass' };
      return { action: 'play', play: possiblePlays[0] };
      
    case 'balanced':
    default:
      if (possiblePlays.length === 1) {
        return Math.random() < 0.7 ? 
          { action: 'play', play: possiblePlays[0] } : 
          { action: 'pass' };
      }
      
      if (gameState.lastPlayStrength >= HAND_RANKS.STRAIGHT) {
        if (Math.random() < 0.5) return { action: 'pass' };
      }
      
      return { action: 'play', play: chooseBestPlay(possiblePlays, gameState) };
  }
}

// 최적 플레이 선택
function chooseBestPlay(possiblePlays, gameState) {
  if (possiblePlays.length === 1) return possiblePlays[0];
  
  if (gameState.gamePhase === 'endgame') {
    return possiblePlays[0];
  }
  
  if (gameState.gamePhase === 'midgame') {
    if (gameState.isWinning) {
      return possiblePlays[0];
    } else {
      const midIndex = Math.floor(possiblePlays.length / 2);
      return possiblePlays[midIndex];
    }
  }
  
  const randomIndex = Math.floor(Math.random() * Math.min(3, possiblePlays.length));
  return possiblePlays[randomIndex];
}

// 조합 찾기 함수들
function findAllFiveCardCombos(cards) {
  const combos = [];
  
  if (cards.length >= 5) {
    const symbolGroups = {};
    cards.forEach(card => {
      if (!symbolGroups[card.symbol]) symbolGroups[card.symbol] = [];
      symbolGroups[card.symbol].push(card);
    });
    
    Object.values(symbolGroups).forEach(group => {
      if (group.length >= 5) {
        combos.push(group.slice(0, 5));
      }
    });
  }
  
  return combos;
}

function findAllTriples(cards) {
  const numberGroups = {};
  cards.forEach(card => {
    if (!numberGroups[card.number]) numberGroups[card.number] = [];
    numberGroups[card.number].push(card);
  });
  
  return Object.values(numberGroups)
    .filter(group => group.length >= 3)
    .map(group => group.slice(0, 3));
}

function findAllPairs(cards) {
  const numberGroups = {};
  cards.forEach(card => {
    if (!numberGroups[card.number]) numberGroups[card.number] = [];
    numberGroups[card.number].push(card);
  });
  
  return Object.values(numberGroups)
    .filter(group => group.length >= 2)
    .map(group => group.slice(0, 2));
}

function findPossibleAiPlays(cards, lastPlay, playerCount) {
  const targetLength = lastPlay.cards.length;
  const possiblePlays = [];
  
  try {
    if (targetLength === 1) {
      cards.forEach(card => {
        const hand = analyzeHand([card], playerCount);
        if (hand && compareHands(hand, lastPlay.hand) > 0) {
          possiblePlays.push({ cards: [card], hand });
        }
      });
    } else if (targetLength === 2) {
      const numberGroups = {};
      cards.forEach(card => {
        if (!numberGroups[card.number]) numberGroups[card.number] = [];
        numberGroups[card.number].push(card);
      });
      
      Object.values(numberGroups).forEach(group => {
        if (group.length >= 2) {
          const pair = group.slice(0, 2);
          const hand = analyzeHand(pair, playerCount);
          if (hand && compareHands(hand, lastPlay.hand) > 0) {
            possiblePlays.push({ cards: pair, hand });
          }
        }
      });
    } else if (targetLength === 3) {
      const numberGroups = {};
      cards.forEach(card => {
        if (!numberGroups[card.number]) numberGroups[card.number] = [];
        numberGroups[card.number].push(card);
      });
      
      Object.values(numberGroups).forEach(group => {
        if (group.length >= 3) {
          const triple = group.slice(0, 3);
          const hand = analyzeHand(triple, playerCount);
          if (hand && compareHands(hand, lastPlay.hand) > 0) {
            possiblePlays.push({ cards: triple, hand });
          }
        }
      });
    } else if (targetLength === 5) {
      const combos = findAllFiveCardCombos(cards);
      combos.forEach(combo => {
        const hand = analyzeHand(combo, playerCount);
        if (hand && compareHands(hand, lastPlay.hand) > 0) {
          possiblePlays.push({ cards: combo, hand });
        }
      });
    }
  } catch (error) {
    console.error('AI play error:', error);
  }
  
  return possiblePlays.sort((a, b) => compareHands(a.hand, b.hand));
}

// 게임 상태 브로드캐스트 함수
function broadcastGameUpdate(room) {
  room.players.forEach(roomPlayer => {
    if (!roomPlayer.isAI && !roomPlayer.hasLeft) {
      const playerSocket = io.sockets.sockets.get(roomPlayer.id);
      if (playerSocket) {
        playerSocket.emit('gameUpdated', {
          room: sanitizeRoom(room, roomPlayer.id)
        });
      }
    }
  });
}

// AI 플레이어 함수 (연속 AI 턴 버그 수정)
const aiPlay = (room, playerIndex) => {
  const roomId = room.id;
  
  // 중복 실행 방지 체크
  const executionState = aiExecutionState.get(roomId);
  if (executionState && executionState.isExecuting) {
    console.log('AI already executing, skipping duplicate call');
    return;
  }
  
  // 실행 상태 설정
  aiExecutionState.set(roomId, { isExecuting: true, lastPlayerIndex: playerIndex });
  
  console.log('AI play function called for player:', playerIndex);
  
  try {
    if (!room || room.gameState !== 'playing' || !room.players[playerIndex]) {
      console.log('Invalid room or game state or player');
      return;
    }
    
    const aiPlayer = room.players[playerIndex];
    
    if (!aiPlayer.isAI) {
      console.log('Player is not AI:', aiPlayer);
      return;
    }
    
    const availableCards = aiPlayer.cards;
    
    if (!availableCards || availableCards.length === 0) {
      console.log('No cards available for AI');
      return;
    }
    
    const gameState = analyzeGameState(room, playerIndex);
    const strategy = determineStrategy(room, playerIndex, gameState);
    
    if (room.lastPlay.cards.length === 0) {
      const opening = chooseStrategicOpening(availableCards, gameState, strategy, room.players.length);
      executeAiPlay(room, playerIndex, opening.cards, opening.hand);
    } else {
      const decision = makeStrategicDecision(room, playerIndex, gameState, strategy);
      
      if (decision.action === 'play') {
        const strategyHints = {
          'aggressive_finish': ['(승부수!)', '(올인!)', '(마지막 스퍼트!)'],
          'power_play': ['(강한 수!)', '(파워 플레이!)', '(압도적!)'],
          'maintain_lead': ['(안정적)', '(계산된 수)', '(여유롭게)'],
          'catch_up': ['(추격!)', '(역전 노리기)', '(필사적으로)'],
          'conservative': ['(신중하게)', '(보수적으로)', '(차분하게)'],
          'balanced': ['(균형잡힌)', '(전략적으로)', '(계산된)']
        };
        
        const hints = strategyHints[strategy] || [''];
        const hint = hints[Math.floor(Math.random() * hints.length)];
        
        executeAiPlay(room, playerIndex, decision.play.cards, decision.play.hand, hint);
      } else {
        const passReasons = {
          'maintain_lead': ['(여유있게 패스)', '(상황 관망)', '(시간 돌기)'],
          'power_play': ['(더 좋은 기회를 위해)', '(숨은 카드 보호)', '(타이밍 기다리는 중)'],
          'conservative': ['(신중한 판단)', '(위험 회피)', '(보수적 선택)'],
          'balanced': ['(전략적 패스)', '(계산된 포기)', '(다음 기회를 위해)']
        };
        
        const reasons = passReasons[strategy] || [''];
        const reason = reasons[Math.floor(Math.random() * reasons.length)];
        
        const logEntry = `${aiPlayer.name}: 패스 ${reason}`;
        room.gameLog.push(logEntry);
        
        room.passCount++;
        
        if (room.passCount >= room.players.filter(p => !p.hasLeft).length - 1) {
          const lastCardPlayer = room.lastPlay.player;
          room.lastPlay = { cards: [], player: null, hand: null };
          room.passCount = 0;
          room.currentPlayer = lastCardPlayer !== null ? lastCardPlayer : 0;
          const logEntry2 = `${room.players[room.currentPlayer]?.name || ''}님이 선이 되었습니다.`;
          room.gameLog.push(logEntry2);
        } else {
          room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
        }
        
        broadcastGameUpdate(room);
        
        // 다음 플레이어도 AI인 경우 처리 (연속 AI 턴 버그 수정)
        setTimeout(() => {
          if (room.gameState === 'playing') {
            const nextPlayer = room.players[room.currentPlayer];
            if (nextPlayer && nextPlayer.isAI && !nextPlayer.hasLeft) {
              console.log('Next player is also AI, triggering next AI play');
              aiPlay(room, room.currentPlayer);
            }
          }
        }, 1000);
      }
    }
  } catch (error) {
    console.error('AI play error:', error);
  } finally {
    // 실행 상태 해제
    aiExecutionState.delete(roomId);
  }
};

// AI 플레이 실행 함수
function executeAiPlay(room, playerIndex, selectedCards, hand, hint = '') {
  try {
    const player = room.players[playerIndex];
    
    player.cards = player.cards.filter(
      card => !selectedCards.find(selected => selected.id === card.id)
    );
    
    room.lastPlay = { cards: selectedCards, player: playerIndex, hand };
    room.passCount = 0;
    
    // 플레이어 플레이 기록에 추가
    if (!room.playerPlays[playerIndex]) {
      room.playerPlays[playerIndex] = [];
    }
    room.playerPlays[playerIndex].push({
      cards: selectedCards,
      hand: hand,
      timestamp: Date.now()
    });
    
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
    
    const logEntry = `${player.name}: ${handNames[hand.rank]} (${selectedCards.length}장) ${hint}`;
    room.gameLog.push(logEntry);
    
    if (player.cards.length === 0) {
      endRound(room, playerIndex);
    } else {
      room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
    }
    
    broadcastGameUpdate(room);
    
    // 다음 플레이어도 AI인 경우 처리 (연속 AI 턴 버그 수정)
    setTimeout(() => {
      if (room.gameState === 'playing') {
        const nextPlayer = room.players[room.currentPlayer];
        if (nextPlayer && nextPlayer.isAI && !nextPlayer.hasLeft) {
          console.log('Next player is also AI, triggering next AI play');
          aiPlay(room, room.currentPlayer);
        }
      }
    }, 1000);
    
  } catch (error) {
    console.error('Execute AI play error:', error);
  }
}

// 다음 활성 플레이어 찾기 (나간 플레이어 제외)
function getNextActivePlayer(room, currentIndex) {
  let nextPlayer = (currentIndex + 1) % room.players.length;
  let attempts = 0;
  
  while (attempts < room.players.length) {
    if (!room.players[nextPlayer].hasLeft) {
      return nextPlayer;
    }
    nextPlayer = (nextPlayer + 1) % room.players.length;
    attempts++;
  }
  
  return currentIndex; // 모든 플레이어가 나간 경우 현재 플레이어 유지
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
      isHost: true,
      isAI: false,
      hasLeft: false
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
    
    if (room.players.filter(p => !p.isAI && !p.hasLeft).length >= room.playerCount) {
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
      isHost: false,
      isAI: false,
      hasLeft: false
    };
    
    room.players.push(player);
    players.set(socket.id, { id: socket.id, name: playerName, roomId });
    
    socket.join(roomId);
    io.to(roomId).emit('playerJoined', { 
      player: { id: player.id, name: player.name },
      room: sanitizeRoom(room, socket.id)
    });
  });

  // AI 플레이어 추가 (다양한 이름으로 수정)
  socket.on('addAI', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error', { message: '호스트만 AI를 추가할 수 있습니다.' });
      return;
    }
    
    if (room.players.length >= 5) {
      socket.emit('error', { message: '최대 5명까지만 참가할 수 있습니다.' });
      return;
    }
    
    if (room.gameState !== 'waiting') {
      socket.emit('error', { message: '게임이 진행 중일 때는 AI를 추가할 수 없습니다.' });
      return;
    }
    
    // 다양한 AI 이름
    const aiNames = [
      '카드마스터 알파', '렉시오 레전드', '전략의 달인', '승부사 베타', 
      '포커페이스 감마', '블러프 킹', '카드샤크 델타', '게임 구루',
      '스마트 플레이어', '카드 위저드', '전술가 엡실론', '게임 엔진',
      '천재 플레이어', '카드 마에스트로', '전략왕 제타', '승부의 신',
      '카드 아티스트', '게임 마스터', '전략가 에타', '렉시오 프로',
      '카드 닌자', '게임 지니어스', '전술왕 세타', '카드 엠페러',
      '스마트 에이스', '게임 레전드', '전략 마스터', '카드 체스터',
      '게임 사무라이', '렉시오 황제', '전술의 신', '카드 현자',
      '스마트 킹', '게임 마법사', '전략 천재', '카드 챔피언'
    ];
    const randomName = aiNames[Math.floor(Math.random() * aiNames.length)];
    
    const aiPlayer = {
      id: `ai-${Date.now()}-${Math.random()}`,
      name: `${randomName}`,
      cards: [],
      isHost: false,
      isAI: true,
      hasLeft: false
    };
    
    room.players.push(aiPlayer);
    
    io.to(playerData.roomId).emit('playerJoined', { 
      player: { id: aiPlayer.id, name: aiPlayer.name },
      room: sanitizeRoom(room, socket.id)
    });
  });

  // AI 플레이어 제거
  socket.on('removeAI', (data) => {
    const { aiPlayerId } = data;
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error', { message: '호스트만 AI를 제거할 수 있습니다.' });
      return;
    }
    
    if (room.gameState !== 'waiting') {
      socket.emit('error', { message: '게임이 진행 중일 때는 AI를 제거할 수 없습니다.' });
      return;
    }
    
    room.players = room.players.filter(p => p.id !== aiPlayerId);
    
    io.to(playerData.roomId).emit('playerLeft', {
      playerId: aiPlayerId,
      room: sanitizeRoom(room, socket.id)
    });
  });

  // 게임 시작 (AI 선패 오류 수정)
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
    
    const activePlayers = room.players.filter(p => !p.hasLeft);
    if (activePlayers.length < 3) {
      socket.emit('error', { message: '최소 3명이 필요합니다. AI를 추가해주세요.' });
      return;
    }
    
    if (startGame(playerData.roomId)) {
      room.players.forEach(roomPlayer => {
        if (!roomPlayer.isAI && !roomPlayer.hasLeft) {
          const playerSocket = io.sockets.sockets.get(roomPlayer.id);
          if (playerSocket) {
            playerSocket.emit('gameStarted', {
              room: sanitizeRoom(room, roomPlayer.id)
            });
          }
        }
      });
      
      setTimeout(() => {
        room.players.forEach(roomPlayer => {
          if (!roomPlayer.isAI && !roomPlayer.hasLeft) {
            const playerSocket = io.sockets.sockets.get(roomPlayer.id);
            if (playerSocket) {
              playerSocket.emit('gameUpdated', {
                room: sanitizeRoom(room, roomPlayer.id)
              });
            }
          }
        });
        
        // AI 선패 처리 (수정됨)
        if (room.gameState === 'playing') {
          const startPlayer = room.players[room.currentPlayer];
          if (startPlayer && startPlayer.isAI && !startPlayer.hasLeft) {
            console.log('AI is starting player, triggering AI play');
            setTimeout(() => {
              aiPlay(room, room.currentPlayer);
            }, 2000); // 2초 후 AI 플레이 시작
          }
        }
      }, 500);
    }
  });

  // 플레이어 방 나가기 (수정됨 - 게임 상태 업데이트 추가)
  socket.on('leaveRoom', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    if (room.gameState === 'waiting') {
      // 로비에서는 플레이어를 완전히 제거
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (room.players.length === 0) {
        rooms.delete(playerData.roomId);
      } else {
        // 호스트가 나간 경우 다음 플레이어를 호스트로
        if (player.isHost) {
          const nextHost = room.players.find(p => !p.isAI && !p.hasLeft);
          if (nextHost) {
            nextHost.isHost = true;
          } else if (room.players.length > 0) {
            room.players[0].isHost = true;
          }
        }
        
        socket.to(playerData.roomId).emit('playerLeft', {
          playerId: socket.id,
          room: sanitizeRoom(room)
        });
      }
    } else {
      // 게임 중에는 나간 상태로 표시
      player.hasLeft = true;
      room.gameLog.push(`${player.name}님이 게임을 나갔습니다.`);
      
      // 나간 플레이어가 현재 턴이면 다음 플레이어로 넘김
      if (room.currentPlayer === room.players.findIndex(p => p.id === socket.id)) {
        room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
      }
      
      // 호스트가 나간 경우 다른 플레이어에게 호스트 권한 이양
      if (player.isHost) {
        const nextHost = room.players.find(p => !p.isAI && !p.hasLeft);
        if (nextHost) {
          nextHost.isHost = true;
          player.isHost = false;
        }
      }
      
      // 게임 상태 업데이트 전송 (추가됨)
      setTimeout(() => {
        broadcastGameUpdate(room);
        
        // AI 턴 체크 (플레이어 이탈 후 AI 턴이 될 수 있음)
        if (room.gameState === 'playing') {
          const currentPlayer = room.players[room.currentPlayer];
          if (currentPlayer && currentPlayer.isAI && !currentPlayer.hasLeft) {
            console.log('Player left, checking if AI turn');
            setTimeout(() => {
              aiPlay(room, room.currentPlayer);
            }, 1000);
          }
        }
      }, 100);
      
      socket.to(playerData.roomId).emit('playerLeft', {
        playerId: socket.id,
        room: sanitizeRoom(room)
      });
    }
    
    socket.leave(playerData.roomId);
    players.delete(socket.id);
    
    socket.emit('leftRoom');
  });

  // 카드 플레이
  socket.on('playCards', (data) => {
    try {
      const playerData = players.get(socket.id);
      if (!playerData) {
        socket.emit('error', { message: '플레이어 정보를 찾을 수 없습니다.' });
        return;
      }
      
      const room = rooms.get(playerData.roomId);
      if (!room || room.gameState !== 'playing') {
        socket.emit('error', { message: '게임 방을 찾을 수 없거나 게임이 진행 중이 아닙니다.' });
        return;
      }
      
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex === -1) {
        socket.emit('error', { message: '게임 참가자가 아닙니다.' });
        return;
      }
      
      if (playerIndex !== room.currentPlayer) {
        socket.emit('error', { message: '당신의 턴이 아닙니다.' });
        return;
      }
      
      const player = room.players[playerIndex];
      if (player.hasLeft) {
        socket.emit('error', { message: '게임을 나간 플레이어는 플레이할 수 없습니다.' });
        return;
      }
      
      const { selectedCards } = data;
      
      if (!selectedCards || selectedCards.length === 0) {
        socket.emit('error', { message: '카드를 선택해주세요.' });
        return;
      }
      
      const hand = analyzeHand(selectedCards, room.players.length);
      
      if (!hand) {
        socket.emit('error', { message: '올바르지 않은 조합입니다.' });
        return;
      }
      
      if (room.lastPlay.hand) {
        if (selectedCards.length !== room.lastPlay.cards.length) {
          socket.emit('error', { message: `${room.lastPlay.cards.length}장의 카드를 내야 합니다.` });
          return;
        }
        
        const comparison = compareHands(hand, room.lastPlay.hand);
        
        if (comparison <= 0) {
          socket.emit('error', { message: '더 높은 조합을 내야 합니다.' });
          return;
        }
      }
      
      player.cards = player.cards.filter(
        card => !selectedCards.find(selected => selected.id === card.id)
      );
      
      room.lastPlay = { cards: selectedCards, player: playerIndex, hand };
      room.passCount = 0;
      
      // 플레이어 플레이 기록에 추가
      if (!room.playerPlays[playerIndex]) {
        room.playerPlays[playerIndex] = [];
      }
      room.playerPlays[playerIndex].push({
        cards: selectedCards,
        hand: hand,
        timestamp: Date.now()
      });
      
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
      
      if (player.cards.length === 0) {
        endRound(room, playerIndex);
      } else {
        room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
      }
      
      room.players.forEach(roomPlayer => {
        if (!roomPlayer.isAI && !roomPlayer.hasLeft) {
          const playerSocket = io.sockets.sockets.get(roomPlayer.id);
          if (playerSocket) {
            playerSocket.emit('gameUpdated', {
              room: sanitizeRoom(room, roomPlayer.id)
            });
          }
        }
      });
      
      // AI 턴 체크 (플레이어 카드 플레이 후 AI 턴이 될 수 있음)
      setTimeout(() => {
        if (room.gameState === 'playing') {
          const nextPlayer = room.players[room.currentPlayer];
          if (nextPlayer && nextPlayer.isAI && !nextPlayer.hasLeft) {
            console.log('Next player is AI after card play, triggering AI play');
            aiPlay(room, room.currentPlayer);
          }
        }
      }, 500);
      
    } catch (error) {
      console.error('Card play error:', error);
      socket.emit('error', { message: '카드 플레이 중 오류가 발생했습니다.' });
    }
  });

  // 패스
  socket.on('pass', () => {
    try {
      const playerData = players.get(socket.id);
      if (!playerData) return;
      
      const room = rooms.get(playerData.roomId);
      if (!room || room.gameState !== 'playing') return;
      
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== room.currentPlayer) return;
      
      const player = room.players[playerIndex];
      if (player.hasLeft) return;
      
      if (room.lastPlay.cards.length === 0) {
        socket.emit('error', { message: '첫 턴에는 패스할 수 없습니다.' });
        return;
      }
      
      room.gameLog.push(`${player.name}: 패스`);
      
      room.passCount++;
      
      const activePlayers = room.players.filter(p => !p.hasLeft);
      if (room.passCount >= activePlayers.length - 1) {
        const lastCardPlayer = room.lastPlay.player;
        room.lastPlay = { cards: [], player: null, hand: null };
        room.passCount = 0;
        room.currentPlayer = lastCardPlayer !== null ? lastCardPlayer : 0;
        room.gameLog.push(`${room.players[room.currentPlayer]?.name || ''}님이 선이 되었습니다.`);
      } else {
        room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
      }
      
      room.players.forEach(roomPlayer => {
        if (!roomPlayer.isAI && !roomPlayer.hasLeft) {
          const playerSocket = io.sockets.sockets.get(roomPlayer.id);
          if (playerSocket) {
            playerSocket.emit('gameUpdated', {
              room: sanitizeRoom(room, roomPlayer.id)
            });
          }
        }
      });
      
      // AI 턴 체크 (패스 후 AI 턴이 될 수 있음)
      setTimeout(() => {
        if (room.gameState === 'playing') {
          const nextPlayer = room.players[room.currentPlayer];
          if (nextPlayer && nextPlayer.isAI && !nextPlayer.hasLeft) {
            console.log('Next player is AI after pass, triggering AI play');
            aiPlay(room, room.currentPlayer);
          }
        }
      }, 500);
      
    } catch (error) {
      console.error('Pass error:', error);
    }
  });

  // AI 플레이 요청 처리
  socket.on('aiPlay', (data) => {
    try {
      const { playerIndex } = data;
      
      const playerData = players.get(socket.id);
      if (!playerData) return;
      
      const room = rooms.get(playerData.roomId);
      if (!room) return;
      
      if (!room.players[playerIndex] || !room.players[playerIndex].isAI) return;
      
      if (room.currentPlayer !== playerIndex) return;
      
      if (room.gameState === 'playing') {
        aiPlay(room, playerIndex);
      }
    } catch (error) {
      console.error('AI play request error:', error);
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('플레이어 연결 해제:', socket.id);
    const playerData = players.get(socket.id);
    
    if (playerData) {
      const room = rooms.get(playerData.roomId);
      if (room) {
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.gameState === 'waiting') {
          // 로비에서는 완전히 제거
          room.players = room.players.filter(p => p.id !== socket.id);
          
          if (room.players.length === 0) {
            rooms.delete(playerData.roomId);
          } else {
            if (player && player.isHost) {
              const nextHost = room.players.find(p => !p.isAI);
              if (nextHost) {
                nextHost.isHost = true;
              } else if (room.players.length > 0) {
                room.players[0].isHost = true;
              }
            }
            
            socket.to(playerData.roomId).emit('playerLeft', {
              playerId: socket.id,
              room: sanitizeRoom(room)
            });
          }
        } else {
          // 게임 중에는 나간 상태로 표시
          if (player) {
            player.hasLeft = true;
            room.gameLog.push(`${player.name}님의 연결이 끊어졌습니다.`);
            
            if (room.currentPlayer === room.players.findIndex(p => p.id === socket.id)) {
              room.currentPlayer = getNextActivePlayer(room, room.currentPlayer);
            }
            
            if (player.isHost) {
              const nextHost = room.players.find(p => !p.isAI && !p.hasLeft);
              if (nextHost) {
                nextHost.isHost = true;
                player.isHost = false;
              }
            }
            
            // 게임 상태 업데이트 전송 (추가됨)
            setTimeout(() => {
              broadcastGameUpdate(room);
              
              // AI 턴 체크 (연결 끊김 후 AI 턴이 될 수 있음)
              if (room.gameState === 'playing') {
                const currentPlayer = room.players[room.currentPlayer];
                if (currentPlayer && currentPlayer.isAI && !currentPlayer.hasLeft) {
                  console.log('Player disconnected, checking if AI turn');
                  setTimeout(() => {
                    aiPlay(room, room.currentPlayer);
                  }, 1000);
                }
              }
            }, 100);
            
            socket.to(playerData.roomId).emit('playerLeft', {
              playerId: socket.id,
              room: sanitizeRoom(room)
            });
          }
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
  
  const cardCounts = room.players.map(player => {
    if (player.hasLeft) return 0;
    let count = player.cards.length;
    const twos = player.cards.filter(card => card.number === 2).length;
    return count * Math.pow(2, twos);
  });
  
  for (let i = 0; i < room.players.length; i++) {
    if (i !== winnerIndex && !room.players[i].hasLeft) {
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
      cardCount: player.cards ? player.cards.length : 0,
      cards: player.id === requesterId ? (player.cards || []) : [],
      isHost: player.isHost,
      isAI: player.isAI,
      hasLeft: player.hasLeft
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