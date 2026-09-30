import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';

// Mount the real Group Monitor pages and prove that opening/closing them
// neither starts nor stops (nor duplicates) the background service.
const mocks = vi.hoisted(() => ({
    intervals: new Map(),
    nextTimer: 1,
    request: vi.fn(async () => ({ results: [], totalCount: 0 })),
    fetch: vi.fn(async () => new Response('{}', { status: 200 }))
}));

vi.mock('worker-timers', () => ({
    setInterval: (fn, ms) => {
        const id = mocks.nextTimer++;
        mocks.intervals.set(id, { fn, ms });
        return id;
    },
    clearInterval: (id) => mocks.intervals.delete(id),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn()
}));
vi.mock('../../../services/request', () => ({
    request: (...a) => mocks.request(...a)
}));
vi.mock('../../../services/sqlite', () => ({
    default: {
        execute: vi.fn(async () => {}),
        executeNonQuery: vi.fn(async () => 0)
    }
}));
vi.mock('../../../services/auditLogDb', () => ({
    auditDbLoadEntries: vi.fn(async () => []),
    auditDbSaveEntries: vi.fn(async () => {}),
    auditDbLoadMeta: vi.fn(async () => null),
    auditDbSaveMeta: vi.fn(async () => {}),
    auditDbMigrateFromLocalStorage: vi.fn(async () => {})
}));
vi.mock('../../../services/groupMonitor/storage', async () => {
    const { createMemoryMonitorStorage } =
        await import('../../../services/groupMonitor/memoryStorage');
    return { default: createMemoryMonitorStorage() };
});
vi.mock('../../../coordinators/userCoordinator', () => ({
    showUserDialog: vi.fn()
}));
vi.mock('vue-router', () => ({
    useRoute: () => ({ name: 'group-monitor-webhooks' })
}));
vi.mock('echarts', () => ({
    init: () => ({ setOption() {}, resize() {}, dispose() {}, getDom() {} })
}));

const fakes = await vi.hoisted(async () => {
    const { reactive } = await import('vue');
    const gid = 'grp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    return {
        gid,
        user: reactive({ currentUser: { id: '' } }),
        group: reactive({
            currentUserGroups: new Map([
                [
                    gid,
                    { id: gid, name: 'Alpha', myMember: { permissions: ['*'] } }
                ]
            ]),
            currentUserGroupsInit: false
        }),
        location: reactive({ lastLocation: { location: '' } })
    };
});
vi.mock('../../../stores/user', () => ({ useUserStore: () => fakes.user }));
vi.mock('../../../stores/group', () => ({ useGroupStore: () => fakes.group }));
vi.mock('../../../stores/location', () => ({
    useLocationStore: () => fakes.location
}));

import { i18n } from '../../../plugins/i18n';
import { watchState } from '../../../services/watchState';
import { useGroupMonitorStore } from '../../../stores/groupMonitor';
import GroupCrash from '../GroupCrash.vue';
import GroupWebhooks from '../GroupWebhooks.vue';

async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

let store;
let nativeIntervals;

beforeEach(async () => {
    vi.stubGlobal('fetch', (...a) => mocks.fetch(...a));
    nativeIntervals = new Set();
    const origSet = globalThis.setInterval;
    const origClear = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
        (fn, ms, ...rest) => {
            const id = origSet(fn, ms, ...rest);
            nativeIntervals.add(id);
            return id;
        }
    );
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((id) => {
        nativeIntervals.delete(id);
        return origClear(id);
    });
    setActivePinia(createPinia());
    store = useGroupMonitorStore();
    fakes.user.currentUser = { id: 'usr_a' };
    watchState.isLoggedIn = true;
    await flush();
    fakes.group.currentUserGroupsInit = true;
    await flush();
});

afterEach(() => {
    store.stop();
    store.$dispose();
    watchState.isLoggedIn = false;
    fakes.group.currentUserGroupsInit = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    ['GroupWebhooks', GroupWebhooks, 'Background monitoring'],
    ['GroupCrash', GroupCrash, 'Instance Crash Detection']
])('%s page', (_name, Page, marker) => {
    test('mount/unmount x3: no duplicate timers, service keeps running', async () => {
        expect(store.serviceState).toBe('running');
        expect(mocks.intervals.size).toBe(1);
        for (let i = 0; i < 3; i++) {
            const w = mount(Page, {
                global: { plugins: [i18n], stubs: { teleport: true } }
            });
            await flush();
            expect(w.text()).toContain(marker);
            // the page's own UI refresh timers are ref-counted: at most 2 (audit + vote-kick)
            expect(nativeIntervals.size).toBeLessThanOrEqual(2);
            expect(mocks.intervals.size).toBe(1);
            w.unmount();
            await flush();
            expect(nativeIntervals.size).toBe(0);
            expect(mocks.intervals.size).toBe(1);
            expect(store.serviceState).toBe('running');
            expect(store._hasTimer()).toBe(true);
        }
    });
});
