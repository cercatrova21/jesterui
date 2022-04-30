import React, { useEffect, useState, useCallback, MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Game } from '../context/GamesContext'
import Chessboard from '../components/chessground/Chessground'
import PgnTable from '../components/chessground/PgnTable'
import { SelectedBot } from '../components/BotSelector'
import * as Bot from '../util/bot'
import { db, NostrEvent, NostrEventRef } from '../util/db'
import { useLiveQuery } from 'dexie-react-hooks'

import { AppSettings, useSettings, useSettingsDispatch } from '../context/SettingsContext'
import {
  useOutgoingNostrEvents,
} from '../context/NostrEventsContext'
import * as NIP01 from '../util/nostr/nip01'
import * as NostrEvents from '../util/nostr/events'
import * as AppUtils from '../util/pgnrui'
import { getSession } from '../util/session'
import { PgnruiMove, GameStart, GameMove } from '../util/pgnrui'
import CreateGameButton from './CreateGameButton'

// @ts-ignore
import Heading1 from '@material-tailwind/react/Heading1'
// @ts-ignore
import * as Chess from 'chess.js'
import { ChessInstance } from '../components/ChessJsTypes'
import * as cg from 'chessground/types'

type MovebleColor = [] | [cg.Color] | ['white', 'black']

const WAITING_DURATION_IN_MS = process.env.NODE_ENV === 'development' ? 3_000 : 10_000

function BoardContainer({ game, onGameChanged }: { game: Game; onGameChanged: (game: ChessInstance) => void }) {
  const updateGameCallback = (modify: (g: ChessInstance) => void) => {
    console.debug('[Chess] updateGameCallback invoked')
    const copyOfGame = { ...game.game }
    modify(copyOfGame)
    onGameChanged(copyOfGame)
  }

  return (
    <>
      <div>
        <div style={{ width: 400, height: 400 }}>
          {game && <Chessboard game={game!.game} userColor={game!.color} onAfterMoveFinished={updateGameCallback} />}
        </div>
        {false && game && (
          <div className="pl-2 overflow-y-scroll">
            <PgnTable game={game!.game} />
          </div>
        )}
      </div>
    </>
  )
}

const BotMoveSuggestions = ({ game }: { game: Game | null }) => {
  const settings = useSettings()

  const [selectedBot] = useState<SelectedBot>(
    (() => {
      if (settings.botName && Bot.Bots[settings.botName]) {
        return {
          name: settings.botName,
          move: Bot.Bots[settings.botName](),
        }
      }
      return null
    })()
  )

  const [isThinking, setIsThinking] = useState(false)
  const [thinkingFens, setThinkingFens] = useState<Bot.Fen[]>([])
  const [latestThinkingFen, setLatestThinkingFen] = useState<Bot.Fen | null>(null)
  const [move, setMove] = useState<Bot.ShortMove | null>(null)
  const [gameOver, setGameOver] = useState<boolean>(game?.game.game_over() || false)

  useEffect(() => {
    if (game === null) return

    if (game.game.game_over()) {
      setGameOver(true)
      return
    }

    const currentFen = game.game.fen()
    setThinkingFens((currentFens) => {
      if (currentFens[currentFens.length - 1] === currentFen) {
        return currentFens
      }
      return [...currentFens, currentFen]
    })
  }, [game])

  useEffect(() => {
    if (!selectedBot) return
    if (isThinking) return
    if (thinkingFens.length === 0) return

    const thinkingFen = thinkingFens[thinkingFens.length - 1]

    const timer = setTimeout(() => {
      const inBetweenUpdate = thinkingFen !== thinkingFens[thinkingFens.length - 1]
      if (inBetweenUpdate) return

      setIsThinking(true)
      setLatestThinkingFen(thinkingFen)
      console.log(`Asking bot ${selectedBot.name} for move suggestion to ${thinkingFen}...`)

      selectedBot.move(thinkingFen).then(({ from, to }: Bot.ShortMove) => {
        console.log(`Bot ${selectedBot.name} found move from ${from} to ${to}.`)

        setMove({ from, to })

        setIsThinking(false)
        setThinkingFens((currentFens) => {
          const i = currentFens.indexOf(thinkingFen)
          if (i < 0) {
            return currentFens
          }

          const copy = [...currentFens]
          // remove all thinking fens that came before this
          copy.splice(0, i + 1)
          return copy
        })
      })
    }, 100)

    return () => {
      clearTimeout(timer)
    }
  }, [selectedBot, thinkingFens, isThinking])

  if (!selectedBot) {
    return <>No bot selected.</>
  }

  return (
    <>
      {`${selectedBot.name}`}
      {gameOver ? (
        ` is ready for the next game.`
      ) : (
        <>
          {!isThinking && !move && thinkingFens.length === 0 && ` is idle...`}
          {isThinking && thinkingFens.length > 0 && ` is thinking (${thinkingFens.length})...`}
          {!isThinking && move && ` suggests ${JSON.stringify(move)}`}
          {/*Latest Thinking Fen: {latestThinkingFen}*/}
        </>
      )}
    </>
  )
}

const GameOverMessage = ({ game }: { game: Game }) => {
  if (!game.game.game_over()) {
    return <></>
  }

  if (game.game.in_stalemate()) {
    return <>Game over: Draw by stalemate!</>
  }
  if (game.game.in_threefold_repetition()) {
    return <>Game over: Draw by threefold repetition!</>
  }
  if (game.game.insufficient_material()) {
    return <>Game over: Draw by insufficient material!</>
  }

  if (game.game.in_draw()) {
    return <>Game over: Draw!</>
  }

  return <>Game over: {`${game.game.turn() === 'b' ? 'White' : 'Black'} won`}</>
}


const GameEventsDebugDiv = ({ game }: { game: Game }) => {

  const listOfReferencingEvents = useLiveQuery(async () => {
    const events = (await db.nostr_event_refs
      .where('targetIds').equals(game.id)
      .toArray())

    return events
  },
  [game], [] as NostrEventRef[]
)

  return (<>
    <div className="my-4">
        {listOfReferencingEvents.map((it) => {
          return (
            <div key={it.sourceId}>
              {JSON.stringify(it)}
            </div>
          )
        })}
      </div>
  </>)
}

const GameStateMessage = ({ game }: { game: Game }) => {
  if (game.game.game_over()) {
    return <GameOverMessage game={game} />
  }

  return <>{`${game.game.turn() === 'b' ? 'black' : 'white'}`} to move</>
}

const LoadingBoard = () => {
  const loadingGame = {
      id: 'loading_game',
      game: new Chess.Chess(),
      color: [],
  } as Game
  
  return (
      <div style={{ filter: 'grayscale()' }}>
        {<BoardContainer game={loadingGame} onGameChanged={() => {}} />}
      </div>
  )
}

export default function GameByIdFromStore({ gameId: argGameId }: { gameId?: NIP01.Sha256 | undefined }) {
  const { gameId: paramsGameId } = useParams<{ gameId: NIP01.Sha256 | undefined }>()
  const [gameId] = useState<NIP01.Sha256 | undefined>(argGameId || paramsGameId)

  const navigate = useNavigate()
  const outgoingNostr = useOutgoingNostrEvents()
  const settings = useSettings()
  const settingsDispatch = useSettingsDispatch()

  const [humanReadableError, setHumanReadableError] = useState<string | null>(null)
  const [currentGame, setCurrentGame] = useState<Game | null>(null)
  const [currentGameHead, setCurrentGameHead] = useState<PgnruiMove | null>(null)
  const [isSearchingHead, setIsSearchingHead] = useState(true)

  // TODO: "isLoading" is more like "isWaiting",.. e.g. no game is found.. can be in incoming events the next second,
  // in 10 seconds, or never..
  const [isLoading, setIsLoading] = useState<boolean>(true)


  // -----------------------
  const hasReferencingEvents = async (refId: NIP01.EventId) => {
    return (await db.nostr_event_refs
        .where('targetIds').equals(refId)
        .limit(1).count()) > 0
  }

  const findReferencingEvents = async (refId: NIP01.EventId) => {
    const eventsRefs = (await db.nostr_event_refs
        .where('targetIds').equals(refId)
        .toArray())

    const events = (await db.nostr_events
      .where('id').anyOf(eventsRefs.map((it) => it.sourceId))
      .toArray())
  
    return events
  }

  const allGameEvents = useLiveQuery(async () => {
    if (!gameId) return []

    const events = (await findReferencingEvents(gameId))
    return events
  }, [gameId, currentGameHead], [] as NostrEvent[]
  )

  const currentGameStart = useLiveQuery(async () => {
    if (!gameId) return  
    const event = await db.nostr_events.get(gameId)

    if (!event || !AppUtils.isStartGameEvent(event)) {
      return
    }

    return new GameStart(event)
  }, [gameId]
  )

  const newestHeads = useLiveQuery(async () => {
    if (!currentGameHead) return []

    const currentHeadId = currentGameHead.event().id
    const events = (await findReferencingEvents(currentHeadId))
    return events
  }, [currentGameHead], [] as NostrEvent[]
  )

  //------------------------

  const publicKeyOrNull = settings.identity?.pubkey || null
  const privateKeyOrNull = getSession()?.privateKey || null

  const onChessboardChanged = async (chessboard: ChessInstance) => {
    if (!currentGame) return null

    // TODO: Should we additionally set the game here?
    // leaning towards no.. leads to waiting time before
    // the move is made for the event via nostr to return..
    // but better than to be in an inconsitent state...
    /*setCurrentGame((currentGame) => {
      if (!currentGame) return null
      return { ...currentGame, game: chessboard }
    })*/
    console.log('WILL SEND THE EVENT VIA NOSTR...')
    await sendGameStateViaNostr(currentGame, chessboard)
  }

  const sendGameStateViaNostr = async (currentGame: Game, chessboard: ChessInstance) => {
    if (!outgoingNostr) {
      console.info('Nostr EventBus not ready..')
      return
    }
    if (!publicKeyOrNull) {
      console.info('PubKey not available..')
      return
    }
    if (!privateKeyOrNull) {
      console.info('PrivKey not available..')
      return
    }
    if (!currentGameHead || !currentGameStart) {
      console.info('Game head not available..')
      return
    }

    const publicKey = publicKeyOrNull!
    const privateKey = privateKeyOrNull!

    const history = chessboard.history()
    const latestMove = (history && history[history.length - 1]) || null
    console.log('[]: ', latestMove)

    const eventParts = NostrEvents.blankEvent()
    eventParts.kind = 1 // text_note
    eventParts.pubkey = publicKey
    eventParts.created_at = Math.floor(Date.now() / 1000)
    eventParts.content = JSON.stringify({
      version: '0',
      fen: chessboard.fen(),
      move: latestMove,
      history: history,
    })
    eventParts.tags = [
      ['e', currentGameStart.event().id],
      ['e', currentGameHead.event().id],
    ]

    await new Promise<void>(function (resolve) {
      setTimeout(async () => {
        try {
          const event = NostrEvents.constructEvent(eventParts)
          const signedEvent = await NostrEvents.signEvent(event, privateKey)
          outgoingNostr.emit(NIP01.ClientEventType.EVENT, NIP01.createClientEventMessage(signedEvent))
        } finally {
          resolve()
        }
      }, 100)
    })
  }

  const onGameCreated = async (e: MouseEvent<HTMLButtonElement>, gameId: NIP01.Sha256) => {
    // TODO: this is a hack so we do not need to watch for gameId changes..
    // please, please please.. try to remove it and immediately
    // navigate to /game/:gameId
    navigate(`/redirect/game/${gameId}`)
  }

  /**  MOVE UPDATES******************************************************************* */
  const color = useCallback(() => {
    let color: MovebleColor = []
    if (!currentGameStart || privateKeyOrNull === null || publicKeyOrNull === null) {
      color = []
    } else {
      if (publicKeyOrNull === currentGameStart.event().pubkey) {
        color = ['white']
      } else {
        color = ['black']
      }
    }
    /*if (process.env.NODE_ENV === 'development') {
      color =  ['white', 'black']
    }*/
    return color
  }, [currentGameStart, privateKeyOrNull, publicKeyOrNull])

  useEffect(() => {
    if (!currentGameStart) {
      setCurrentGame(null)
      return
    }

    setCurrentGame((_) => ({
      id: currentGameStart.event().id, // TODO should the game hold the hole event?
      game: new Chess.Chess(),
      color: color(),
    }))
  }, [currentGameStart, color])

  // TODO: maybe do not start the game at "game start", but initialize with latest event?
  useEffect(() => {
    if (!currentGameHead) return
    if (isSearchingHead) return

    setCurrentGame((current) => {
      if (!current) return current

      // TODO: does the "game" really need to change, or can you just do:
      // current.game.load_pgn(history.join('\n'))
      // without returning a copy?
      const newGame = new Chess.Chess()
      const loaded = newGame.load_pgn(currentGameHead.pgn())
      console.log('LOADED NEW GAME STATE FROM PGN', loaded, currentGameHead.pgn())

      return { ...current, game: newGame }
    })
  }, [isSearchingHead, currentGameHead])
  /********************** */

  useEffect(() => {
    if (!currentGameStart) return

    const currentGameFilter = AppUtils.createGameFilter(currentGameStart)

    const currentSubs = settings.subscriptions || []
    const currentSubFilters = currentSubs.filter((it) => it.id === 'my-sub').map((it) => it.filters)[0]

    // this is soo stupid..
    const currentGameFilterJson = JSON.stringify(currentGameFilter)
    const containsCurrentGameFilter = currentSubFilters.filter(it => JSON.stringify(it) === currentGameFilterJson).length > 0

    if (!containsCurrentGameFilter) {
      // TODO: Replace with "updateSubscriptionSettings"
      settingsDispatch({
        ...settings,
        subscriptions: [
          {
            id: 'my-sub',
            filters: [...currentSubFilters, currentGameFilter],
          },
        ],
      } as AppSettings)
    }
  }, [currentGameStart, settings, settingsDispatch])
  
  const findNewHead = useCallback(
    (currentGameStart: AppUtils.GameStart, currentHead: AppUtils.PgnruiMove | null): AppUtils.PgnruiMove => {
      if (!currentHead) {
        return currentGameStart
      }

      const currentHeadId = currentHead.event().id

      console.log(`Start gathering events referencing current head event ${currentHeadId}`)
      const successors = newestHeads

      if (successors.length === 0) {
        console.log('Search for current head is over, a head without children has been found.')
        return currentHead
      }

      successors.sort((a, b) => b.created_at - a.created_at)

      console.log(`Found ${successors.length} events referencing the current event...`)

      const earliestArrivingChild = successors[successors.length - 1]
      if (earliestArrivingChild.id === currentHeadId) {
        return currentHead
      }

      try {
        const newHead = new GameMove(earliestArrivingChild, currentHead)
        return newHead
      } catch (err) {
        // this can happen anytime someone sends an event thats not a valid successor to the current head
        console.error(err, earliestArrivingChild.content, currentHead.content())
        return currentHead
      }
    },
    [newestHeads]
  )

  
  useEffect(() => {
    if (!currentGameStart) {
      return
    }

    const abortCtrl = new AbortController()
    const newHead = findNewHead(currentGameStart, currentGameHead)

    hasReferencingEvents(newHead.event().id)
      .then((newHeadHasChildren) => {
        if (abortCtrl.signal.aborted) return

        setCurrentGameHead(newHead)
        //const newHeadHasChildren = children.length !== 0
        setIsSearchingHead(newHeadHasChildren)
      })
      .catch((e) => console.error(e))

    return () => {
      abortCtrl.abort()
    }
  }, [currentGameStart, currentGameHead, findNewHead])

  useEffect(() => {
    const abortCtrl = new AbortController()
    const timer = setTimeout(() => !abortCtrl.signal.aborted && setIsLoading(false), WAITING_DURATION_IN_MS)

    return () => {
      abortCtrl.abort()
      clearTimeout(timer)
    }
  }, [])

  if (!gameId) {
    return <div>Error: GameId not present</div>
  }

  if (isLoading && currentGame === null) {
    return <>Loading... (waiting for game data to arrive)</>
  }

  if (currentGame === null) {
    return (
      <div>
        <div>Game not found...</div>
        <div>{humanReadableError && `${humanReadableError}`}</div>
        <CreateGameButton onGameCreated={onGameCreated} />
      </div>
    )
  }

  return (
    <div className="screen-game-by-id">
      <Heading1 color="blueGray">
        GameByIdFromStore <span className="font-mono">{AppUtils.gameDisplayName(gameId)}</span>
      </Heading1>

      <div>{`You are ${currentGame.color.length === 0 ? 'in watch-only mode' : currentGame.color}`}</div>
      <div>
        {isSearchingHead ? (<>
          <div>{`Loading...`}</div>
          <div><LoadingBoard /></div>
        </>) : (<>
          <div>{<GameStateMessage game={currentGame} />}</div>
          <div><BoardContainer game={currentGame} onGameChanged={onChessboardChanged} /></div>
        </>)}
      </div>
      <div><BotMoveSuggestions game={isSearchingHead ? null : currentGame} /></div>
      <div>{<GameEventsDebugDiv game={currentGame} />}</div>
      {/*currentGameStart && (
        <div style={{ maxWidth: 600, overflowX: 'scroll' }}>
          <pre>{JSON.stringify(currentGameStart.event(), null, 2)}</pre>
        </div>
      )*/}
    </div>
  )
}

