import { beforeEach, describe, expect, test, vi } from 'vitest';

// Startup reconstruction of the current instance and player list:
// - VRCX (re)started while VRChat is already in an instance (from the gamelog DB)
// - VRCX started after joining (from the output_log backlog)
// - two VRChat clients running at once (a second account with --profile=1)

const mocks = vi.hoisted(() => {
    function stub(overrides = {}) {
        const fns = {};
        return new Proxy(overrides, {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (prop === 'then' || typeof prop === 'symbol') return undefined;
                if (!fns[prop]) fns[prop] = vi.fn();
                return fns[prop];
            }
        });
    }

    const db = {
        location: [],
        joinLeave: [],
        maxTableSize: 500
    };

    function emptyLocation() {
        return { date: 0, location: '', name: '', playerList: new Map(), friendList: new Map() };
    }

    const locationStore = stub({
        lastLocation: emptyLocation(),
        setLastLocation(value) {
            locationStore.lastLocation = value;
        },
        setLastLocationLocation(value) {
            locationStore.lastLocation.location = value;
        },
        setLastLocationDestination: () => {},
        setLastLocationDestinationTime: () => {}
    });

    const userStore = stub({
        currentUser: { id: 'usr_main' },
        cachedUsers: new Map(),
        cachedProfiles: new Map(),
        cachedUserIdsByDisplayName: new Map()
    });

    const gameLogStore = stub({
        state: { lastLocationAvatarList: new Map() },
        addGamelogLocationToDatabase(entry) {
            db.location.push({ ...entry });
        }
    });

    // mirrors locationCoordinator.runLastLocationResetFlow: everyone in the
    // list gets an OnPlayerLeft row and the location is cleared
    function runLastLocationResetFlow(gameLogDate) {
        const dateTime = gameLogDate || new Date().toJSON();
        for (const ref of locationStore.lastLocation.playerList.values()) {
            db.joinLeave.push({
                created_at: dateTime,
                type: 'OnPlayerLeft',
                displayName: ref.displayName,
                location: locationStore.lastLocation.location,
                userId: ref.userId
            });
        }
        locationStore.setLastLocation(emptyLocation());
    }

    return {
        stub,
        db,
        emptyLocation,
        locationStore,
        userStore,
        gameLogStore,
        gameStore: { isGameRunning: true },
        runLastLocationResetFlow: vi.fn(runLastLocationResetFlow),
        airiIntegrationStore: stub({ enabled: true, handlePlayerJoined: vi.fn() }),
        rawLogs: []
    };
});

vi.mock('vue-sonner', () => ({ toast: vi.fn() }));
vi.mock('../../plugins/i18n', () => ({ i18n: { global: { t: (key) => key } } }));
vi.mock('../../services/appConfig', () => ({ AppDebug: {}, logWebRequest: vi.fn() }));
vi.mock('../../services/watchState', () => ({ watchState: {} }));
vi.mock('../../services/config', () => ({ default: { setBool: vi.fn(), setString: vi.fn() } }));
vi.mock('../../api', () => ({
    userRequest: { getUser: vi.fn(), getPublicProfile: vi.fn() }
}));
vi.mock('worker-timers', () => ({ setTimeout: (fn) => fn() }));

vi.mock('../../shared/utils', () => ({
    createJoinLeaveEntry: (type, dt, displayName, location, userId, time = 0) => ({
        created_at: dt,
        type,
        displayName,
        location,
        userId,
        time
    }),
    createLocationEntry: (dt, location, worldId, worldName) => ({
        created_at: dt,
        type: 'Location',
        location,
        worldId,
        worldName,
        groupName: '',
        time: 0
    }),
    createPortalSpawnEntry: vi.fn(),
    createResourceLoadEntry: vi.fn(),
    findUserByDisplayName: () => undefined,
    parseLocation: (location) => ({ worldId: location.split(':')[0] }),
    parseInventoryFromUrl: vi.fn(),
    parsePrintFromUrl: vi.fn(),
    replaceBioSymbols: (value) => value,
    getGroupName: () => Promise.resolve('')
}));

vi.mock('../../services/database', () => {
    const { db } = mocks;
    const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    return {
        database: {
            getLastDateGameLogDatabase: vi.fn(async () => '2026-09-30T00:00:00.000Z'),
            addGamelogJoinLeaveToDatabase: (entry) => db.joinLeave.push({ ...entry }),
            addGamelogJoinLeaveBulk: vi.fn(),
            addGamelogPortalSpawnToDatabase: vi.fn(),
            addGamelogResourceLoadToDatabase: vi.fn(),
            updateGamelogLocationTimeToDatabase: vi.fn(),
            // the old startup source: newest maxTableSize rows across tables
            getGamelogDatabase: vi.fn(async () => {
                const rows = [...db.location, ...db.joinLeave].sort(byTime);
                return rows.slice(-db.maxTableSize);
            }),
            // same semantics as the SQL in services/database/gameLog.js
            getGamelogCurrentInstance: vi.fn(async () => {
                const last = db.location[db.location.length - 1];
                if (!last) return [];
                const rows = db.joinLeave
                    .filter(
                        (row) =>
                            (row.location === last.location || row.location === '') &&
                            row.created_at >= last.created_at
                    )
                    .sort(byTime);
                return [{ ...last }, ...rows.map((row) => ({ ...row }))];
            })
        }
    };
});

vi.mock('../locationCoordinator', () => ({
    runLastLocationResetFlow: mocks.runLastLocationResetFlow,
    runUpdateCurrentUserLocationFlow: vi.fn()
}));

vi.mock('../../stores/settings/advanced', () => ({
    useAdvancedSettingsStore: () => mocks.stub({ gameLogDisabled: false })
}));
vi.mock('../../stores/settings/general', () => ({
    useGeneralSettingsStore: () => mocks.stub({ logResourceLoad: false })
}));
vi.mock('../../stores/friend', () => ({ useFriendStore: () => mocks.stub({ friends: new Map() }) }));
vi.mock('../../stores/gallery', () => ({ useGalleryStore: () => mocks.stub() }));
vi.mock('../../stores/game', () => ({ useGameStore: () => mocks.gameStore }));
vi.mock('../../stores/gameLog', () => ({ useGameLogStore: () => mocks.gameLogStore }));
vi.mock('../../stores/instance', () => ({ useInstanceStore: () => mocks.stub() }));
vi.mock('../../stores/location', () => ({ useLocationStore: () => mocks.locationStore }));
vi.mock('../../stores/modal', () => ({ useModalStore: () => mocks.stub() }));
vi.mock('../../stores/notification', () => ({ useNotificationStore: () => mocks.stub() }));
vi.mock('../../stores/photon', () => ({
    usePhotonStore: () => mocks.stub({ photonLobbyAvatars: new Map() })
}));
vi.mock('../../stores/sharedFeed', () => ({ useSharedFeedStore: () => mocks.stub() }));
vi.mock('../../stores/user', () => ({ useUserStore: () => mocks.userStore }));
vi.mock('../../stores/vr', () => ({ useVrStore: () => mocks.stub() }));
vi.mock('../../stores/vrcx', () => ({ useVrcxStore: () => mocks.stub({ ipcEnabled: false }) }));
vi.mock('../../stores/groupInvite', () => ({
    useGroupInviteStore: () => mocks.stub({ autoInviteEnabled: false })
}));
vi.mock('../../stores/airiIntegration', () => ({
    useAiriIntegrationStore: () => mocks.airiIntegrationStore
}));

import { addGameLogEvent, getGameLogTable, tryLoadPlayerList } from '../gameLogCoordinator';
import { gameLogClients } from '../../shared/utils/gameLogClients';

const CLUB = 'wrld_club:19054~group(grp_x)~region(us)';
const HOME = 'wrld_home:98437~region(jp)';
const MAIN_LOG = 'output_log_2026-09-29_21-59-35.txt';
const MEOW_LOG = 'output_log_2026-09-30_02-06-35.txt';

let clock;
function at(minutes) {
    return new Date(Date.parse('2026-09-30T02:00:00.000Z') + minutes * 60000).toJSON();
}
function tick() {
    clock += 0.05;
    return at(clock);
}

// raw LogWatcher rows: [fileName, dt, type, ...args]
function auth(file, userId, name) {
    return [file, tick(), 'user-authenticated', userId, name];
}
function joinRoom(file, location, worldName) {
    return [file, tick(), 'location', location, worldName];
}
function joined(file, n) {
    return [file, tick(), 'player-joined', `Player ${n}`, `usr_${n}`];
}
function left(file, n) {
    return [file, tick(), 'player-left', `Player ${n}`, `usr_${n}`];
}
function closed(file) {
    return [file, tick(), 'log-closed'];
}

function live(row) {
    addGameLogEvent(JSON.stringify(row));
}

async function startVrcxWithBacklog(rows) {
    mocks.rawLogs = rows;
    await getGameLogTable();
}

// what a VRCX restart does: fresh stores, then rebuild from the DB
async function restartVrcx() {
    gameLogClients.reset();
    mocks.locationStore.setLastLocation(mocks.emptyLocation());
    await tryLoadPlayerList();
}

function players() {
    return [...mocks.locationStore.lastLocation.playerList.keys()].sort();
}
function ids(...numbers) {
    return numbers.map((n) => `usr_${n}`).sort();
}

beforeEach(() => {
    clock = 0;
    mocks.db.location.length = 0;
    mocks.db.joinLeave.length = 0;
    mocks.db.maxTableSize = 500;
    mocks.gameStore.isGameRunning = true;
    mocks.userStore.currentUser = { id: 'usr_main' };
    mocks.locationStore.setLastLocation(mocks.emptyLocation());
    mocks.airiIntegrationStore.handlePlayerJoined.mockClear();
    gameLogClients.reset();
    vi.stubGlobal('LogWatcher', {
        SetDateTill: vi.fn(),
        Get: vi.fn(async () => {
            const rows = mocks.rawLogs;
            mocks.rawLogs = [];
            return rows;
        })
    });
});

describe('single client', () => {
    test('VRCX restart restores the instance and everyone already there', async () => {
        live(joinRoom(MAIN_LOG, HOME, 'VRChat Home'));
        live(joined(MAIN_LOG, 90));
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        [1, 2, 3, 4].forEach((n) => live(joined(MAIN_LOG, n)));
        live(left(MAIN_LOG, 2));

        await restartVrcx();
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(mocks.locationStore.lastLocation.name).toBe('Just B Club');
        expect(players()).toEqual(ids(1, 3, 4));

        live(joined(MAIN_LOG, 5));
        live(left(MAIN_LOG, 1));
        expect(players()).toEqual(ids(3, 4, 5));
    });

    test('the Location row is the oldest row the DB returns', async () => {
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        live(joined(MAIN_LOG, 1));
        await restartVrcx();
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1));
    });

    test('busy lobby: the Location row is older than the newest 500 rows', async () => {
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        for (let n = 1; n <= 40; n++) live(joined(MAIN_LOG, n));
        // hours of churn: 300 people come and go (600 rows)
        for (let n = 100; n < 400; n++) {
            live(joined(MAIN_LOG, n));
            live(left(MAIN_LOG, n));
        }
        live(joined(MAIN_LOG, 999));
        expect(mocks.db.joinLeave.length).toBeGreaterThan(mocks.db.maxTableSize);

        await restartVrcx();
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        const expected = Array.from({ length: 40 }, (_, i) => i + 1).concat(999);
        expect(players()).toEqual(ids(...expected));
    });

    test('earlier visits to the same instance do not leak into the list', async () => {
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        live(joined(MAIN_LOG, 1));
        live(joinRoom(MAIN_LOG, HOME, 'VRChat Home'));
        live(joined(MAIN_LOG, 2));
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        live(joined(MAIN_LOG, 3));

        await restartVrcx();
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(3));
    });

    test('VRCX started after joining: the log backlog fills the list', async () => {
        await startVrcxWithBacklog([
            auth(MAIN_LOG, 'usr_main', 'i am pawtistic'),
            joinRoom(MAIN_LOG, HOME, 'VRChat Home'),
            joinRoom(MAIN_LOG, CLUB, 'Just B Club'),
            joined(MAIN_LOG, 1),
            joined(MAIN_LOG, 2),
            joined(MAIN_LOG, 3),
            left(MAIN_LOG, 3)
        ]);
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1, 2));
        // AIRI's /paw/players lookups see the people already present too
        expect(mocks.airiIntegrationStore.handlePlayerJoined).toHaveBeenCalledWith('usr_1');

        live(joined(MAIN_LOG, 4));
        expect(players()).toEqual(ids(1, 2, 4));

        await restartVrcx();
        expect(players()).toEqual(ids(1, 2, 4));
    });
});

describe('two VRChat clients (second account with --profile=1)', () => {
    test("the other client's world change does not replace your instance or list", async () => {
        live(auth(MAIN_LOG, 'usr_main', 'i am pawtistic'));
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        [1, 2, 3].forEach((n) => live(joined(MAIN_LOG, n)));

        live(auth(MEOW_LOG, 'usr_meow', 'meow meow'));
        live(joinRoom(MEOW_LOG, HOME, 'VRChat Home'));
        live(joined(MEOW_LOG, 50));

        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1, 2, 3));
        expect(mocks.db.joinLeave.filter((row) => row.type === 'OnPlayerLeft')).toHaveLength(0);

        live(joined(MAIN_LOG, 4));
        await restartVrcx();
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1, 2, 3, 4));
    });

    test('same instance: joins are not recorded twice', async () => {
        live(auth(MAIN_LOG, 'usr_main', 'i am pawtistic'));
        live(auth(MEOW_LOG, 'usr_meow', 'meow meow'));
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        live(joinRoom(MEOW_LOG, CLUB, 'Just B Club'));
        live(joined(MAIN_LOG, 1));
        live(joined(MEOW_LOG, 1));
        expect(mocks.db.joinLeave.filter((row) => row.userId === 'usr_1')).toHaveLength(1);
        expect(players()).toEqual(ids(1));
    });

    test('backlog: the newest log belonging to the other client is ignored', async () => {
        // LogWatcher reads files one after another (oldest first), so the
        // other client's rows arrive after yours regardless of time
        await startVrcxWithBacklog([
            auth(MAIN_LOG, 'usr_main', 'i am pawtistic'),
            joinRoom(MAIN_LOG, CLUB, 'Just B Club'),
            joined(MAIN_LOG, 1),
            joined(MAIN_LOG, 2),
            auth(MEOW_LOG, 'usr_meow', 'meow meow'),
            joinRoom(MEOW_LOG, HOME, 'VRChat Home'),
            joined(MEOW_LOG, 50)
        ]);
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1, 2));
    });

    test('backlog: other client listed first is ignored as well', async () => {
        await startVrcxWithBacklog([
            auth(MEOW_LOG, 'usr_meow', 'meow meow'),
            joinRoom(MEOW_LOG, HOME, 'VRChat Home'),
            joined(MEOW_LOG, 50),
            auth(MAIN_LOG, 'usr_main', 'i am pawtistic'),
            joinRoom(MAIN_LOG, CLUB, 'Just B Club'),
            joined(MAIN_LOG, 1)
        ]);
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1));
        expect(mocks.db.location.map((row) => row.location)).toEqual([CLUB]);
    });

    test('only the other client running: its instance is still followed', async () => {
        await startVrcxWithBacklog([
            auth(MAIN_LOG, 'usr_main', 'i am pawtistic'),
            joinRoom(MAIN_LOG, CLUB, 'Just B Club'),
            joined(MAIN_LOG, 1),
            closed(MAIN_LOG),
            auth(MEOW_LOG, 'usr_meow', 'meow meow'),
            joinRoom(MEOW_LOG, CLUB, 'Just B Club'),
            joined(MEOW_LOG, 1),
            joined(MEOW_LOG, 2)
        ]);
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
        expect(players()).toEqual(ids(1, 2));

        live(joined(MEOW_LOG, 3));
        expect(players()).toEqual(ids(1, 2, 3));
    });

    test('your client exits while the other keeps running: follow the other one', async () => {
        live(auth(MAIN_LOG, 'usr_main', 'i am pawtistic'));
        live(auth(MEOW_LOG, 'usr_meow', 'meow meow'));
        live(joinRoom(MAIN_LOG, CLUB, 'Just B Club'));
        live(joined(MAIN_LOG, 1));
        live(joined(MEOW_LOG, 2)); // ignored, your client is running
        expect(players()).toEqual(ids(1));

        live(closed(MAIN_LOG));
        live(joined(MEOW_LOG, 3));
        expect(players()).toEqual(ids(1, 3));
        expect(mocks.locationStore.lastLocation.location).toBe(CLUB);
    });

    test('not logged in yet: nothing is filtered', async () => {
        mocks.userStore.currentUser = {};
        live(auth(MAIN_LOG, 'usr_main', 'i am pawtistic'));
        live(auth(MEOW_LOG, 'usr_meow', 'meow meow'));
        live(joinRoom(MEOW_LOG, HOME, 'VRChat Home'));
        live(joined(MEOW_LOG, 50));
        expect(mocks.locationStore.lastLocation.location).toBe(HOME);
        expect(players()).toEqual(ids(50));
    });
});
