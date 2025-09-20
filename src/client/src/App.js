import React, { useState, useEffect, useCallback } from 'react';
import io from 'socket.io-client';
import { Sun, Star, Moon, Cloud, Users, Play, RotateCcw, Trophy, Coins, Copy, LogOut, Crown } from 'lucide-react';

const SYMBOLS = {
  sun: { icon: Sun, name: '해', color: 'text-yellow-500', bg: 'bg-yellow-100' },
  moon: { icon: Moon, name: '달', color: 'text-blue-500', bg: 'bg-blue-100' },
  star: { icon: Star, name: '별', color: 'text-purple-500', bg: 'bg-purple-100' },
  cloud: { icon: Cloud, name: '구름', color: 'text-gray-500', bg: 'bg-gray-100' }
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

const compareCards = (card1, card2) => {
  const num1Index = NUMBER_ORDER.indexOf(card1.number);
  const num2Index = NUMBER_ORDER.indexOf(card2.number);
  
  if (num1Index !== num2Index) {
    return num1Index - num2Index;
  }
  
  return SYMBOL_ORDER.indexOf(card1.symbol) - SYMBOL_ORDER.indexOf(card2.symbol);
};

const checkStraight = (sortedCards) => {
  const numbers = sortedCards.map(card => NUMBER_ORDER.indexOf(card.number));
  numbers.sort((a, b) => a - b);
  
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i + 1] - numbers[i] !== 1) {
      return false;
    }
  }
  
  return true;
};

const analyzeHand = (cards) => {
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
};

const Card = ({ card, selected, onClick, size = 'normal' }) => {
  if (!card) return null;
  
  const Symbol = SYMBOLS[card.symbol]?.icon;
  if (!Symbol) return null;
  
  const sizeClasses = {
    small: 'w-10 h-14 text-xs',
    normal: 'w-12 h-16 text-sm',
    large: 'w-16 h-20 text-base'
  };
  
  return (
    <div
      className={`${sizeClasses[size]} border-2 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all
        ${selected ? 'border-blue-500 bg-blue-50 -translate-y-2' : 'border-gray-300 bg-white'}
        ${SYMBOLS[card.symbol].bg} hover:shadow-md active:scale-95`}
      onClick={onClick}
    >
      <Symbol className={`w-3 h-3 sm:w-4 sm:h-4 ${SYMBOLS[card.symbol].color}`} />
      <span className="font-bold mt-1">{card.number}</span>
    </div>
  );
};

const getHandName = (hand) => {
  if (!hand) return '?';
  
  const names = {
    [HAND_RANKS.SINGLE]: '싱글',
    [HAND_RANKS.PAIR]: '페어',
    [HAND_RANKS.TRIPLE]: '트리플',
    [HAND_RANKS.STRAIGHT]: '스트레이트',
    [HAND_RANKS.FLUSH]: '플러쉬',
    [HAND_RANKS.FULL_HOUSE]: '풀하우스',
    [HAND_RANKS.FOUR_KIND]: '포카드',
    [HAND_RANKS.STRAIGHT_FLUSH]: '스트레이트플러쉬'
  };
  return names[hand.rank] || '?';
};

const OnlineLexioGame = () => {
  const [socket, setSocket] = useState(null);
  const [gameMode, setGameMode] = useState('menu'); // menu, lobby, playing
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [room, setRoom] = useState(null);
  const [selectedCards, setSelectedCards] = useState([]);
  const [error, setError] = useState('');
  const [myPlayerId, setMyPlayerId] = useState('');
  const [aiTurnProcessing, setAiTurnProcessing] = useState(false); // AI 턴 처리 상태 추가

  // AI 턴 자동 처리 useEffect (디버깅 강화)
  useEffect(() => {
    console.log('=== AI TURN CHECK ===');
    console.log('gameMode:', gameMode);
    console.log('room?.gameState:', room?.gameState);
    console.log('room?.currentPlayer:', room?.currentPlayer);
    console.log('aiTurnProcessing:', aiTurnProcessing);
    
    // 게임이 진행 중인지 확인
    if (gameMode !== 'playing' || !room || room.gameState !== 'playing') {
      console.log('Not in playing state');
      return;
    }

    // 현재 플레이어 데이터 확인
    if (!room.players || room.currentPlayer >= room.players.length) {
      console.log('Invalid player index');
      return;
    }

    const currentPlayerData = room.players[room.currentPlayer];
    if (!currentPlayerData) {
      console.log('No current player data');
      return;
    }

    console.log('Current player:', currentPlayerData.name, 'isAI:', currentPlayerData.isAI);

    // AI 턴이고 아직 처리중이 아닌 경우
    if (currentPlayerData.isAI && !aiTurnProcessing) {
      console.log('Setting up AI turn timer...');
      setAiTurnProcessing(true);
      
      // 타이머를 변수에 저장하여 정확한 cleanup
      const aiTimer = setTimeout(() => {
        console.log('AI timer executed - checking conditions...');
        
        // 타이머 실행 시점에 다시 한번 조건 확인
        if (!socket || !socket.connected) {
          console.log('Socket not connected at timer execution');
          setAiTurnProcessing(false);
          return;
        }

        // 최신 room 상태 다시 확인
        if (!room || room.gameState !== 'playing') {
          console.log('Game state changed during timer');
          setAiTurnProcessing(false);
          return;
        }

        const latestCurrentPlayer = room.players[room.currentPlayer];
        if (!latestCurrentPlayer || !latestCurrentPlayer.isAI) {
          console.log('Current player changed or is not AI');
          setAiTurnProcessing(false);
          return;
        }

        console.log('Sending aiPlay event...');
        socket.emit('aiPlay', { 
          playerIndex: room.currentPlayer,
          roomId: room.id,
          timestamp: Date.now()
        });
        
      }, 1500);
      
      // cleanup 함수에서 타이머 정리
      return () => {
        console.log('Cleaning up AI timer');
        clearTimeout(aiTimer);
        setAiTurnProcessing(false);
      };
    }
    
    // AI가 아닌 플레이어인 경우 처리 상태 해제
    if (currentPlayerData && !currentPlayerData.isAI && aiTurnProcessing) {
      console.log('Resetting AI processing state - not AI turn');
      setAiTurnProcessing(false);
    }
    
  }, [room?.currentPlayer, room?.gameState, gameMode, socket?.connected, aiTurnProcessing]);

  // 게임 상태 업데이트 시 AI 처리 상태 초기화
  useEffect(() => {
    if (room && gameMode === 'playing') {
      const currentPlayerData = room.players?.[room.currentPlayer];
      if (currentPlayerData && !currentPlayerData.isAI) {
        setAiTurnProcessing(false);
      }
    }
  }, [room, gameMode]);

  // Socket 연결
  useEffect(() => {
    const newSocket = io(window.location.origin, {
      transports: ['websocket', 'polling']
    });
    setSocket(newSocket);
    
    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      setMyPlayerId(newSocket.id);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setError('서버 연결에 실패했습니다. 페이지를 새로고침해주세요.');
    });

    // 소켓 이벤트 리스너
    newSocket.on('roomCreated', (data) => {
      setRoom(data.room);
      setRoomId(data.roomId);
      setGameMode('lobby');
      setError('');
      setAiTurnProcessing(false); // 상태 초기화
    });

    newSocket.on('playerJoined', (data) => {
      setRoom(data.room);
      setGameMode('lobby'); // 참가자도 로비로 이동
      setError('');
      setAiTurnProcessing(false); // 상태 초기화
    });

    newSocket.on('gameStarted', (data) => {
      console.log('Game started with data:', data);
      setRoom(data.room);
      setGameMode('playing');
      setError('');
      setAiTurnProcessing(false); // 상태 초기화
    });

    newSocket.on('gameUpdated', (data) => {
      console.log('=== GAME UPDATE RECEIVED ===');
      console.log('Update data:', data);
      setRoom(data.room);
      setSelectedCards([]); // 카드 플레이 후 선택 초기화
      setError('');
      setAiTurnProcessing(false); // 게임 상태 업데이트 시 AI 처리 상태 초기화
      console.log('Game state updated');
    });

    newSocket.on('playerLeft', (data) => {
      setRoom(data.room);
      setError('플레이어가 나갔습니다.');
      setAiTurnProcessing(false); // 상태 초기화
    });

    newSocket.on('error', (data) => {
      console.log('Error received:', data.message);
      setError(data.message);
      setAiTurnProcessing(false); // 에러 시 상태 초기화
      // 에러 발생 시 선택된 카드 유지 (다시 시도할 수 있도록)
    });

    return () => {
      newSocket.close();
      setAiTurnProcessing(false); // 클린업 시 상태 초기화
    };
  }, []);

  const createRoom = () => {
    if (!playerName.trim()) {
      setError('플레이어 이름을 입력해주세요.');
      return;
    }
    
    if (!socket || !socket.connected) {
      setError('서버에 연결되지 않았습니다. 페이지를 새로고침해주세요.');
      return;
    }
    
    console.log('Creating room with socket:', socket.id);
    socket.emit('createRoom', {
      playerName: playerName.trim(),
      playerCount: 4
    });
  };

  const joinRoom = () => {
    if (!playerName.trim() || !roomId.trim()) {
      setError('플레이어 이름과 방 코드를 입력해주세요.');
      return;
    }
    
    if (!socket || !socket.connected) {
      setError('서버에 연결되지 않았습니다. 페이지를 새로고침해주세요.');
      return;
    }
    
    console.log('Joining room with socket:', socket.id);
    socket.emit('joinRoom', {
      roomId: roomId.trim().toUpperCase(),
      playerName: playerName.trim()
    });
  };

  const startGame = () => {
    socket.emit('startGame');
  };

  const addAI = () => {
    if (socket) {
      socket.emit('addAI');
    }
  };

  const removeAI = (aiPlayerId) => {
    if (socket) {
      socket.emit('removeAI', { aiPlayerId });
    }
  };

  const nextRound = () => {
    socket.emit('startGame');
  };

  const toggleCardSelection = (card) => {
    setSelectedCards(prev => {
      const isSelected = prev.find(c => c.id === card.id);
      if (isSelected) {
        return prev.filter(c => c.id !== card.id);
      } else {
        return [...prev, card];
      }
    });
  };

  const playCards = () => {
    if (selectedCards.length === 0) return;
    
    const currentPlayerData = room?.players[room?.currentPlayer];
    const isMyTurn = currentPlayerData?.id === myPlayerId;
    
    console.log('=== CLIENT PLAY CARDS ===');
    console.log('Selected cards:', selectedCards);
    console.log('My player ID:', myPlayerId);
    console.log('Current player:', room?.currentPlayer);
    console.log('Is my turn:', isMyTurn);
    
    if (!socket || !socket.connected) {
      setError('서버 연결이 끊어졌습니다. 페이지를 새로고침해주세요.');
      return;
    }
    
    socket.emit('playCards', { selectedCards });
    console.log('Sent playCards event to server');
  };

  const pass = () => {
    socket.emit('pass');
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setError('방 코드가 복사되었습니다!');
    setTimeout(() => setError(''), 2000);
  };

  const leaveRoom = () => {
    setGameMode('menu');
    setRoom(null);
    setRoomId('');
    setSelectedCards([]);
    setError('');
    setAiTurnProcessing(false);
  };

  if (!socket) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p>서버에 연결 중...</p>
        </div>
      </div>
    );
  }

  // 메인 메뉴
  if (gameMode === 'menu') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg p-8 shadow-lg max-w-md w-full">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">렉시오 온라인</h1>
            <p className="text-gray-600">정통 클라이밍 카드 게임</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">플레이어 이름</label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="이름을 입력하세요"
                maxLength={10}
              />
            </div>

            <button
              onClick={createRoom}
              className="w-full bg-blue-500 text-white py-3 rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
            >
              <Users className="w-5 h-5" />
              방 만들기
            </button>

            <div className="text-center text-gray-500">또는</div>

            <div>
              <label className="block text-sm font-medium mb-2">방 코드</label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="방 코드 입력"
                maxLength={6}
              />
            </div>

            <button
              onClick={joinRoom}
              className="w-full bg-green-500 text-white py-3 rounded-lg hover:bg-green-600 transition-colors flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5" />
              방 참가하기
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 로비 (대기실)
  if (gameMode === 'lobby') {
    const myPlayer = room?.players?.find(p => p.id === myPlayerId);
    const isHost = myPlayer?.isHost;

    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg p-6 shadow-lg mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-bold">대기실</h2>
              <button
                onClick={leaveRoom}
                className="text-gray-500 hover:text-gray-700 flex items-center gap-1"
              >
                <LogOut className="w-4 h-4" />
                나가기
              </button>
            </div>

            <div className="flex items-center gap-4 mb-6">
              <div className="bg-gray-100 px-4 py-2 rounded-lg">
                <span className="text-sm text-gray-600">방 코드</span>
                <div className="font-mono text-xl font-bold">{roomId}</div>
              </div>
              <button
                onClick={copyRoomId}
                className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
              >
                <Copy className="w-4 h-4" />
                복사
              </button>
            </div>

            <div className="mb-6">
              <h3 className="font-semibold mb-3">플레이어 목록 ({room?.players?.length || 0}/5)</h3>
              <div className="space-y-2">
                {room?.players?.map((player, index) => (
                  <div key={player.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold">
                        {index + 1}
                      </div>
                      <span className="font-medium">{player.name}</span>
                      {player.isHost && <Crown className="w-4 h-4 text-yellow-500" />}
                      {player.id === myPlayerId && <span className="text-sm text-blue-600">(나)</span>}
                      {player.isAI && <span className="text-sm text-purple-600">AI</span>}
                    </div>
                    {isHost && player.isAI && (
                      <button
                        onClick={() => removeAI(player.id)}
                        className="text-red-500 hover:text-red-700 text-sm"
                      >
                        제거
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {isHost && (
              <div className="mb-6 space-y-3">
                <button
                  onClick={addAI}
                  disabled={room?.players?.length >= 5}
                  className="w-full bg-purple-500 text-white py-2 rounded-lg hover:bg-purple-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  AI 플레이어 추가 ({room?.players?.length || 0}/5)
                </button>
                
                <button
                  onClick={startGame}
                  disabled={room?.players?.length < 3}
                  className="w-full bg-green-500 text-white py-3 rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  <Play className="w-5 h-5" />
                  게임 시작 (최소 3명 필요)
                </button>
              </div>
            )}

            {!isHost && (
              <div className="text-center text-gray-600 py-3">
                호스트가 게임을 시작하기를 기다리는 중...
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-100 border border-red-300 rounded-lg p-4 text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 게임 플레이
  if (gameMode === 'playing' && room) {
    const myPlayer = room.players.find(p => p.id === myPlayerId);
    const currentPlayerData = room.players[room.currentPlayer];
    const isMyTurn = currentPlayerData?.id === myPlayerId;

    return (
      <div className="max-w-6xl mx-auto p-4 bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen">
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">렉시오 온라인</h1>
          <div className="flex justify-center items-center gap-4">
            <span className="text-gray-600">라운드 {room.round}</span>
            <span className="text-gray-600">방 코드: {roomId}</span>
            <button
              onClick={leaveRoom}
              className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
            >
              <LogOut className="w-4 h-4" />
              나가기
            </button>
          </div>
        </div>

        {room.gameState === 'finished' && room.winner && (
          <div className="bg-white rounded-lg p-6 shadow-lg mb-6">
            <div className="text-center">
              <Trophy className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
              <h2 className="text-3xl font-bold text-green-600 mb-4">라운드 종료!</h2>
              <p className="text-xl mb-4">
                <span className="font-semibold text-blue-600">{room.winner.name}</span>님이 승리!
              </p>
              
              <div className="mb-6">
                <h3 className="font-semibold mb-2">현재 점수</h3>
                {room.players.map((player, index) => (
                  <div key={player.id} className="flex justify-between items-center mb-1">
                    <span>{player.name}</span>
                    <span className="font-bold">{room.scores[index]}점</span>
                  </div>
                ))}
              </div>
              
              {myPlayer?.isHost && (
                <button
                  onClick={nextRound}
                  className="bg-green-500 text-white px-6 py-2 rounded-lg hover:bg-green-600 transition-colors"
                >
                  다음 라운드
                </button>
              )}
              
              {!myPlayer?.isHost && (
                <p className="text-gray-600">호스트가 다음 라운드를 시작하기를 기다리는 중...</p>
              )}
            </div>
          </div>
        )}

        {room.gameState === 'playing' && (
          <>
            {/* 점수판 */}
            <div className="bg-white rounded-lg p-4 shadow-lg mb-6">
              <div className="flex justify-between items-center">
                <h3 className="font-semibold flex items-center gap-2">
                  <Coins className="w-5 h-5 text-yellow-500" />
                  점수
                </h3>
                <div className="flex gap-4">
                  {room.players.map((player, index) => (
                    <div key={player.id} className="text-center">
                      <div className="text-sm text-gray-600">{player.name}</div>
                      <div className="font-bold text-lg">{room.scores[index]}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 게임 상태 */}
            <div className="bg-white rounded-lg p-4 shadow-lg mb-6">
              <div className="flex justify-between items-center mb-4">
                <div className="text-lg font-semibold">
                  현재 턴: <span className="text-blue-600">{currentPlayerData?.name}</span>
                  {isMyTurn && <span className="text-green-600 ml-2">(나의 턴)</span>}
                  {currentPlayerData?.isAI && <span className="text-purple-600 ml-2">(AI)</span>}
                </div>
                <div className="text-sm text-gray-600">
                  {room.lastPlay.hand && `마지막: ${getHandName(room.lastPlay.hand)} (${room.lastPlay.cards.length}장)`}
                </div>
              </div>
              
              {room.lastPlay.cards.length > 0 && (
                <div className="text-center">
                  <p className="text-sm text-gray-600 mb-2">마지막 플레이</p>
                  <div className="flex justify-center gap-1">
                    {room.lastPlay.cards.map((card, index) => (
                      <Card key={`${card.id}-${index}`} card={card} size="small" />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 다른 플레이어들 - 상단에 작게 표시 */}
            <div className="bg-white rounded-lg p-3 shadow-lg mb-4">
              <h3 className="font-semibold mb-2 text-sm text-center">다른 플레이어</h3>
              <div className="flex justify-center gap-3 flex-wrap">
                {room.players
                  .filter(player => player.id !== myPlayerId)
                  .map((player) => {
                    const playerIndex = room.players.findIndex(p => p.id === player.id);
                    return (
                      <div 
                        key={player.id}
                        className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border ${
                          playerIndex === room.currentPlayer 
                            ? 'border-blue-500 bg-blue-50' 
                            : 'border-gray-200 bg-gray-50'
                        }`}
                      >
                        <div className="w-6 h-6 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                          {player.name.charAt(0)}
                        </div>
                        <div className="text-center">
                          <div className="text-xs font-medium truncate max-w-16">{player.name}</div>
                          <div className="text-xs text-gray-600">{player.cardCount}장</div>
                        </div>
                        <div className="flex gap-1">
                          {player.isHost && <Crown className="w-3 h-3 text-yellow-500" />}
                          {player.isAI && <span className="text-xs text-purple-600">AI</span>}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* 내 카드 - 큰 영역 */}
            {myPlayer && (
              <div className="bg-white rounded-lg p-4 shadow-lg mb-4">
                <h3 className="font-semibold mb-3 text-center">내 카드</h3>
                <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2 justify-items-center">
                  {myPlayer && myPlayer.cards && myPlayer.cards.length > 0 ? (
                    myPlayer.cards.map(card => (
                      <Card
                        key={card.id}
                        card={card}
                        selected={selectedCards.find(c => c.id === card.id)}
                        onClick={() => isMyTurn && toggleCardSelection(card)}
                        size="normal"
                      />
                    ))
                  ) : (
                    <div className="col-span-full text-center text-gray-500 py-4">카드 로딩 중...</div>
                  )}
                </div>
                
                {/* 선택된 카드 미리보기 */}
                {selectedCards.length > 0 && (
                  <div className="mt-4 p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-gray-600 mb-2 text-center">선택된 카드</p>
                    <div className="flex justify-center gap-1 mb-2">
                      {selectedCards.map(card => (
                        <Card key={card.id} card={card} size="small" />
                      ))}
                    </div>
                    <p className="text-sm text-center font-medium">
                      {(() => {
                        const hand = analyzeHand(selectedCards);
                        return hand ? getHandName(hand) : '올바르지 않은 조합';
                      })()}
                    </p>
                  </div>
                )}
                
                {/* 플레이 버튼들 - 카드 바로 아래 */}
                {isMyTurn && (
                  <div className="mt-4 flex justify-center gap-3">
                    <button
                      onClick={playCards}
                      disabled={selectedCards.length === 0}
                      className="flex-1 bg-green-500 text-white py-3 px-4 rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      카드 내기 ({selectedCards.length})
                    </button>
                    <button
                      onClick={pass}
                      disabled={room.lastPlay.cards.length === 0}
                      className="flex-1 bg-red-500 text-white py-3 px-4 rounded-lg hover:bg-red-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      패스
                    </button>
                  </div>
                )}
                
                {!isMyTurn && (
                  <div className="mt-4 text-center text-gray-600 py-3 bg-gray-50 rounded-lg">
                    {currentPlayerData?.name}님의 턴입니다
                    {currentPlayerData?.isAI && " (AI 플레이 중...)"}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* 게임 로그 - 컴팩트 */}
        <div className="bg-white rounded-lg p-3 shadow-lg max-h-24 overflow-y-auto mb-4">
          <h3 className="font-semibold mb-2 text-sm">게임 로그</h3>
          <div className="space-y-1">
            {room.gameLog.slice(-5).map((log, index) => (
              <p key={index} className="text-xs text-gray-600">
                {log}
              </p>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-100 border border-red-300 rounded-lg p-4 text-red-700 mb-6">
            {error}
          </div>
        )}

        {/* 게임 규칙 */}
        <div className="bg-white rounded-lg p-4 shadow-lg">
          <h3 className="font-semibold mb-2">게임 규칙</h3>
          <div className="text-sm text-gray-600 space-y-1">
            <p><strong>카드 서열:</strong> 2 &gt; 1 &gt; 15 &gt; 14 &gt; ... &gt; 4 &gt; 3 (2가 가장 강함)</p>
            <p><strong>문양 서열:</strong> 해 &gt; 달 &gt; 별 &gt; 구름</p>
            <p><strong>족보:</strong> 스트레이트플러쉬 &gt; 포카드 &gt; 풀하우스 &gt; 플러쉬 &gt; 스트레이트 &gt; 트리플 &gt; 페어 &gt; 싱글</p>
            <p><strong>게임 진행:</strong> 구름3을 가진 플레이어가 선, 같은 장수의 더 높은 조합을 내거나 패스</p>
            <p><strong>점수:</strong> 게임 종료 시 남은 카드 수만큼 점수 차감 (2를 가지면 2배씩 곱해짐)</p>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default OnlineLexioGame;