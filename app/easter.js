/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';

    self.F = self.F || {};
    F.easter = {};

    F.easter.registerSingle = async function(number) {
        let phone = number.toString().replace(/[.-\s]/g, '');
        const buf = [];
        if (!phone.startsWith('+')) {
            buf.push('+');
        }
        if (!phone.startsWith('1')) {
            buf.push('1');
        }
        buf.push(phone);
        phone = buf.join('');

        const am = await F.foundation.getAccountManager();
        am.requestSMSVerification(phone);
        const $el = $('<div class="ui modal"><div class="ui segment">' +
                      '<div class="ui input action">' +
                      '<input type="text" placeholder="Verification Code..."/>' +
                      '<button class="ui button">Register</button>' +
                      '</div></div></div>');
        $el.on('click', 'button', async function() {
            const code = $el.find('input').val().replace(/[\s-]/g, '');
            await am.registerSingleDevice(phone, code);
            $el.modal('hide');
        });
        $('body').append($el);
        $el.modal('setting', 'closable', false).modal('show');
    };

    F.easter.wipeConverstaions = async function() {
        const p = new Promise((resolve, reject) => {
            const dbreq = indexedDB.open(F.Database.id);
            dbreq.onsuccess = ev => resolve(ev.target.result);
            dbreq.onerror = ev => reject(new Error(ev.target.errorCode));
        });
        const db = await p;
        const t = db.transaction(db.objectStoreNames);
        const conversations = t.objectStore('conversations');
        const messages = t.objectStore('messages');
        const groups = t.objectStore('groups');
        groups.clear();
        messages.clear();
        conversations.clear();
        t.close();
    };

    if (F.addComposeInputFilter) {
        F.addComposeInputFilter(/^\/pat[-_]?factor\b/i, function() {
            return "<img src='/@static/images/tos3.gif'></img>";
        });

        F.addComposeInputFilter(/^\/register\s+(.*)/i, function(number) {
            F.easter.registerSingle(number);
            return `<pre>Starting registration for: ${number}`;
        });

        F.addComposeInputFilter(/^\/wipe/i, function(number) {
            F.easter.wipeConversations(number);
            return '<pre>Wipeing conversations</pre>';
        });
    }

})();
