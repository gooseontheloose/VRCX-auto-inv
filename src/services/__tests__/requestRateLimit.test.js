import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
    vi
} from 'vitest';

const mocks = vi.hoisted(() => ({
    execute: vi.fn()
}));

// Mock router to avoid transitive i18n.global error from columns.jsx
vi.mock('../../plugins/router.js', () => ({
    router: { beforeEach: vi.fn(), push: vi.fn() },
    initRouter: vi.fn()
}));
vi.mock('../webapi.js', () => ({ default: { execute: mocks.execute } }));
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../stores', () => ({
    useAuthStore: () => ({}),
    useModalStore: () => ({}),
    useNotificationStore: () => ({}),
    useUpdateLoopStore: () => ({ setNextGroupInstanceRefresh: vi.fn() }),
    useUserStore: () => ({ currentUser: { id: 'usr_me' } })
}));
vi.mock('../../coordinators/userCoordinator', () => ({
    getCurrentUser: vi.fn()
}));
vi.mock('../../coordinators/groupCoordinator', () => ({
    applyGroup: vi.fn((json) => json)
}));
vi.mock('../watchState', () => ({ watchState: { isLoggedIn: true } }));

import { onVrchatRateLimit } from '../vrchatRateLimit';
import groupRequest from '../../api/group';

const USER = 'usr_00000000-0000-4000-8000-000000000001';

function tooManyRequests() {
    return Promise.resolve({
        status: 429,
        data: JSON.stringify({
            error: { message: 'Too many requests', status_code: 429 }
        })
    });
}

// request() cleans up with a bare req.finally(), whose branch rejects
// unhandled when the request fails; mark those branches handled here.
const realFinally = Promise.prototype.finally;
beforeAll(() => {
    Promise.prototype.finally = function (onFinally) {
        const branch = realFinally.call(this, onFinally);
        branch.catch(() => {});
        return branch;
    };
});
afterAll(() => {
    Promise.prototype.finally = realFinally;
});

beforeEach(() => {
    mocks.execute.mockReset();
});

describe('VRChat 429 at the request layer', () => {
    test('an AIRI group lookup is exactly one HTTP call on a 429 (no retry)', async () => {
        mocks.execute.mockImplementation(tooManyRequests);
        await expect(
            groupRequest.getRepresentedGroup({ userId: USER })
        ).rejects.toMatchObject({ status: 429 });
        expect(mocks.execute).toHaveBeenCalledTimes(1);
    });

    test('every 429 is announced to rate-limit listeners with its endpoint', async () => {
        const seen = [];
        const off = onVrchatRateLimit((endpoint) => seen.push(endpoint));
        try {
            mocks.execute.mockImplementation(tooManyRequests);
            await expect(
                groupRequest.getRepresentedGroup({
                    userId: 'usr_00000000-0000-4000-8000-000000000002'
                })
            ).rejects.toMatchObject({ status: 429 });
            expect(seen).toEqual([
                'users/usr_00000000-0000-4000-8000-000000000002/groups/represented'
            ]);
        } finally {
            off();
        }
    });

    test('other errors are not announced', async () => {
        const seen = [];
        const off = onVrchatRateLimit((endpoint) => seen.push(endpoint));
        try {
            mocks.execute.mockResolvedValue({
                status: 500,
                data: JSON.stringify({
                    error: { message: 'boom', status_code: 500 }
                })
            });
            await expect(
                groupRequest.getRepresentedGroup({
                    userId: 'usr_00000000-0000-4000-8000-000000000003'
                })
            ).rejects.toMatchObject({ status: 500 });
            expect(seen).toEqual([]);
        } finally {
            off();
        }
    });
});
