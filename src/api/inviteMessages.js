import { request } from '../services/request';
import { useUserStore } from '../stores';

function getCurrentUserId() {
    return useUserStore().currentUser.id;
}

const inviteMessagesReq = {
    refreshInviteMessageTableData(messageType, options) {
        return request(`message/${getCurrentUserId()}/${messageType}`, {
            method: 'GET',
            silentErrors: options?.silentErrors
        }).then((json) => {
            const args = {
                json,
                messageType
            };
            return args;
        });
    },

    editInviteMessage(params, messageType, slot, options) {
        return request(`message/${getCurrentUserId()}/${messageType}/${slot}`, {
            method: 'PUT',
            params,
            silentErrors: options?.silentErrors
        }).then((json) => {
            const args = {
                json,
                params,
                messageType,
                slot
            };
            return args;
        });
    }
};

export default inviteMessagesReq;
