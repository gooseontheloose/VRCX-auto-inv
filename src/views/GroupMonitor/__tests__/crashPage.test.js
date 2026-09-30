import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue';

// The Crash page loads its data by itself: on open, on group change, and when
// KeepAlive brings it back (it used to stay empty until the card's refresh).
const mocks = vi.hoisted(() => ({
    intervals: new Map(),
    nextTimer: 1,
    sqlExecute: vi.fn(async () => {}),
    request: vi.fn(async () => ({ results: [], totalCount: 0 }))
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
vi.mock('../../../services/request', () => ({ request: (...a) => mocks.request(...a) }));
vi.mock('../../../services/sqlite', () => ({
    default: {
        execute: (...a) => mocks.sqlExecute(...a),
        executeNonQuery: vi.fn(async () => 0)
    }
}));
vi.mock('../../../services/auditLogDb', () => ({
    auditDbLoadEntries: vi.fn(async () => []),
    auditDbLoadNewest: vi.fn(async () => []),
    auditDbSaveEntries: vi.fn(async () => {}),
    auditDbLoadMeta: vi.fn(async () => null),
    auditDbUpdateMeta: vi.fn(async () => null),
    auditDbSaveMeta: vi.fn(async () => {}),
    auditDbMigrateFromLocalStorage: vi.fn(async () => {})
}));
vi.mock('../../../services/groupMonitor/storage', async () => {
    const { createMemoryMonitorStorage } = await import('../../../services/groupMonitor/memoryStorage');
    return { default: createMemoryMonitorStorage() };
});
vi.mock('../../../coordinators/userCoordinator', () => ({ showUserDialog: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'group-monitor-crash' }) }));
vi.mock('echarts', () => ({
    init: () => ({ setOption() {}, resize() {}, dispose() {}, getDom() {} })
}));

const fakes = await vi.hoisted(async () => {
    const { reactive } = await import('vue');
    const gid = 'grp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const gid2 = 'grp_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    return {
        gid,
        gid2,
        user: reactive({ currentUser: { id: 'usr_a' } }),
        group: reactive({
            currentUserGroups: new Map([
                [gid, { id: gid, name: 'Alpha', myMember: { permissions: ['*'] } }],
                [gid2, { id: gid2, name: 'Bravo', myMember: { permissions: ['*'] } }]
            ]),
            currentUserGroupsInit: true
        }),
        location: reactive({ lastLocation: { location: '' } })
    };
});
vi.mock('../../../stores/user', () => ({ useUserStore: () => fakes.user }));
vi.mock('../../../stores/group', () => ({ useGroupStore: () => fakes.group }));
vi.mock('../../../stores/location', () => ({ useLocationStore: () => fakes.location }));

import { i18n } from '../../../plugins/i18n';
import { useGroupMonitorStore } from '../../../stores/groupMonitor';
import GroupCrash from '../GroupCrash.vue';
import { useGroupMonitorData } from '../useGroupMonitorData';

async function flush() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function crashQueries(groupId) {
    return mocks.sqlExecute.mock.calls.filter(
        ([, sql]) => sql.includes("type = 'OnPlayerLeft'") && sql.includes(groupId)
    ).length;
}

let store;

beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    store = useGroupMonitorStore();
    mocks.sqlExecute.mockClear();
});

afterEach(() => {
    store.stop();
    store.$dispose();
});

describe('Crash page data', () => {
    test('loads on open, on group change, and when it is shown again', async () => {
        const show = ref(true);
        const Other = defineComponent({ render: () => h('div', 'other page') });
        const Host = defineComponent({
            render: () => h(KeepAlive, null, [show.value ? h(GroupCrash) : h(Other)])
        });
        const w = mount(Host, { global: { plugins: [i18n], stubs: { teleport: true } } });
        await flush();
        expect(crashQueries(fakes.gid)).toBeGreaterThanOrEqual(1);

        await useGroupMonitorData().handleGroupChange(fakes.gid2);
        await flush();
        expect(crashQueries(fakes.gid2)).toBe(1);

        show.value = false;
        await nextTick();
        await flush();
        show.value = true;
        await nextTick();
        await flush();
        expect(crashQueries(fakes.gid2)).toBe(2);
        w.unmount();
    });
});
