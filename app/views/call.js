// vim: ts=4:sw=4:expandtab
/* global platform, chrome, moment */

(function () {
    'use strict';

    self.F = self.F || {};

    const logger = F.log.getLogger('views.call');
    logger.setLevel('debug');
    const canFullscreen = document.fullscreenEnabled ||
                          document.mozFullScreenEnabled ||
                          document.webkitFullscreenEnabled;
    const canPopout = document.pictureInPictureEnabled;
    const chromeExtUrl = `https://chrome.google.com/webstore/detail/${F.env.SCREENSHARE_CHROME_EXT_ID}`;
    const chromeWebStoreImage = F.util.versionedURL(F.urls.static + 'images/chromewebstore_v2.png');
    const canAssignAudioOutput = 'sinkId' in HTMLMediaElement.prototype;

    const lowVolume = -40;  // dBV
    const highVolume = -3;  // dBV

    function volumeLoudness(dBV) {
        // Return a loudness percentage for a dBV level.
        const range = highVolume - lowVolume;
        return (range - (highVolume - dBV)) / range;
    }

    let _audioCtx;
    function getAudioContext() {
        // There are limits to how many of these we can use, so share...
        if (_audioCtx === undefined) {
            const _AudioCtx = self.AudioContext || self.webkitAudioContext;
            _audioCtx = _AudioCtx ? new _AudioCtx() : null;
            if (!_audioCtx) {
                logger.warn("Audio not supported");
            }
        }
        return _audioCtx;
    }

    function chromeScreenShareExtRPC(msg) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(F.env.SCREENSHARE_CHROME_EXT_ID, msg, resp => {
                if (!resp) {
                    reject(new ReferenceError('ext not found'));
                } else if (resp.success) {
                    resolve(resp.data);
                } else {
                    reject(resp.error);
                }
            });
        });
    }

    async function hasChromeScreenSharingExt() {
        if (!self.chrome || !self.chrome.runtime) {
            logger.warn("Unsupported browser");
            return false;
        }
        try {
            await chromeScreenShareExtRPC({type: 'ping'});
        } catch(e) {
            if (e instanceof ReferenceError) {
                return false;
            }
            throw e;
        }
        return true;
    }

    async function requestChromeScreenSharing() {
        return await chromeScreenShareExtRPC({type: 'rpc', call: 'chooseDesktopMedia'});
    }

    function limitSDPBandwidth(desc, bandwidth) {
        // Bitrate control is not consistently supported.  This code is basically
        // best effort, in that some clients will handle the AS bitrate statement
        // and others TIAS.
        const sdp = desc.sdp.split(/\r\n/);
        /* Look for existing bitrates and if they are lower use them.  We only look
         * in the video section, hence this strange loop.  We save a reference to
         * the video section for disection later on too. */
        let videoOffset;
        for (let i = 0; i < sdp.length; i++) {
            const line = sdp[i];
            if (videoOffset) {
                if (line.startsWith('b=')) {
                    const adjust = line.startsWith('b=AS') ? 1024 : 1;
                    const bps = Number(line.split(':')[1]) * adjust;
                    if (!bandwidth || bps < bandwidth) {
                        bandwidth = bps;
                    }
                    sdp.splice(i, 1);
                } else if (line.startsWith('m=')) {
                    // This assumes there is only one video section.
                    break;
                }
            } else if (line.startsWith('m=video')) {
                videoOffset = i + 1;
            }
        }
        if (bandwidth) {
            const bps = Math.round(bandwidth);
            const kbps = Math.round(bandwidth / 1024);
            for (let i = videoOffset; i < sdp.length; i++) {
                const line = sdp[i];
                if (line.startsWith('c=IN')) {
                    sdp.splice(i + 1, 0, `b=TIAS:${bps}`);
                    sdp.splice(i + 2, 0, `b=AS:${kbps}`);
                    break;
                }
            }
        }
        return new RTCSessionDescription({
            type: desc.type,
            sdp: sdp.join('\r\n')
        });
    }

    class ForstaRTCPeerConnection extends RTCPeerConnection {

        static makeLabel(id, addr) {
            return `${addr} (peerId:${id})`;
        }

        constructor(id, addr, options) {
            super(options);
            // Workaround for Safari bug: https://bugs.webkit.org/show_bug.cgi?id=172867
            this.__proto__ = ForstaRTCPeerConnection.prototype;
            this._meta = {
                id,
                addr,
                stream: new MediaStream()
            };
            this.label = this.constructor.makeLabel(id, addr);
        }

        setMeta(key, value) {
            this._meta[key] = value;
        }

        getMeta(key) {
            return this._meta[key];
        }

        isConnected() {
            const iceState = this.iceConnectionState;
            return iceState === 'connected' || iceState === 'completed';
        }

        isStale() {
            if (this.isConnected()) {
                return false;
            }
            const lastConnected = this.getMeta('connected');
            const now = Date.now();
            return lastConnected ? (now - lastConnected > 30000) :
                                   (now - this.getMeta('added') > 30000);
        }
    }


    F.CallView = F.View.extend({

        template: 'views/call.html',
        className: 'f-call-view',
        closable: false,  // Prevent accidents and broken fullscreen behavior in safari.

        initialize: function(options) {
            F.assert(options.iceServers);
            F.assert(options.manager);
            this.manager = options.manager;
            this.iceServers = options.iceServers;
            this.forceScreenSharing = options.forceScreenSharing;
            this.offeringPeers = new Map();
            this.memberViews = new Map();
            this._incoming = new Set();
            this._incomingTypes = new Set();
            this._earlyICECandidates = new F.util.DefaultMap(Array);
            this._managerEvents = {
                peerjoin: this.onPeerJoin.bind(this),
                peericecandidates: this.onPeerICECandidates.bind(this),
                peeroffer: this.onPeerOffer.bind(this),
                peeracceptoffer: this.onPeerAcceptOffer.bind(this),
                peerleave: this.onPeerLeave.bind(this),
            };
            for (const [event, listener] of Object.entries(this._managerEvents)) {
                this.manager.addEventListener(event, listener);
            }
            this._fullscreenEvents = {
                mozfullscreenchange: this.onFullscreenChange.bind(this),
                webkitfullscreenchange: this.onFullscreenChange.bind(this),
                fullscreenchange: this.onFullscreenChange.bind(this),
            };
            const ThreadView = {
                conversation: F.ConversationView,
                announcement: F.AnnouncementView
            }[this.model.get('type')];
            this.threadView = new ThreadView({
                model: this.model,
                disableHeader: true,
                disableAside: true
            });
            this.presenterView = new F.CallPresenterView({callView: this});
            this.outView = this.addMemberView(F.currentUser.id, F.currentDevice);
            this.outView.setStatus('Outgoing');
            const urlQuery = new URLSearchParams(location.search);
            if (urlQuery.has('muteCall')) {
                this.outView.toggleSilenced(true);
            }
            if (this.forceScreenSharing) {
                this.$el.addClass('screensharing');
            }
            F.View.prototype.initialize.call(this, options);
        },

        setup: async function() {
            this.$el.toggleClass('debug-stats', !!await F.state.get('callDebugStats'));
            await this.bindOutStream();
            this._soundCheckInterval = setInterval(this.checkSoundLevels.bind(this), 500);
            for (const [event, listener] of Object.entries(this._fullscreenEvents)) {
                document.addEventListener(event, listener);
            }
            this._pausedVideoWatch = setInterval(() => {
                for (const x of this.$('.f-members video')) {
                    if (x.paused) {
                        if (!$(x).parents('.presenting').length) {
                            logger.warn("Found paused video!", x);
                            x.play().catch(() => 0);
                        }
                    }
                }
            }, 2000);
        },

        events: {
            'click .f-leave.button:not(.loading)': 'onLeaveClick',
            'click .f-join-buttons .button': 'onJoinClick',
            'click .f-share.button': 'onShareClick',
            'click .f-video.mute.button': 'onVideoMuteClick',
            'click .f-audio.mute.button': 'onAudioMuteClick',
            'click .f-screenshare.button': 'onScreenShareClick',
            'click .f-detach.button': 'onDetachClick',
            'click .f-fullscreen.button': 'onFullscreenClick',
            'click .f-close.button': 'onCloseClick',
            'click .f-incoming .f-accept.button': 'onIncomingAcceptClick',
            'click .f-incoming .f-ignore.button': 'onIncomingIgnoreClick',
            'click .f-thread-toggle': 'onThreadToggleClick',
            'pointerdown > header': 'onHeaderPointerDown',
            'dblclick > header': 'onHeaderDoubleClick',
        },

        render_attributes: function() {
            return {
                thread: this.model,
                canFullscreen,
                canPopout,
                forceScreenSharing: this.forceScreenSharing,
                callStatus: this._callStatus,
            };
        },

        show: async function() {
            // NOTE: Attach to DOM before render so video elements don't pause.
            $('body').append(this.$el);
            await this.render();
        },

        render: async function() {
            const firstRender = !this._rendered;
            await F.View.prototype.render.call(this);
            this.$('.ui.dropdown').dropdown({
                action: 'hide',
                onChange: value => {
                    if (value === 'settings') {
                        this.onSettingsSelect();
                    } else if (value === 'share-link') {
                        this.onShareLinkSelect();
                    } else {
                        throw new Error("invalid selection");
                    }
                }
            });
            if (firstRender) {
                this.$('.f-presenter').append(this.presenterView.$el);
                for (const view of this.getMemberViews()) {
                    this.$('.f-audience').append(view.$el);
                }
                this.$('.f-thread').append(this.threadView.$el);
                await Promise.all([
                    this.threadView.render(),
                    this.selectPresenter(this.outView)
                ]);
                this.listenTo(this.model.messages, 'add', this.onAddThreadMessage);
            } else {
                for (const view of this.getMemberViews()) {
                    await view.render();
                }
                await this.presenterView.select(this._presenting);
            }
            return this;
        },

        getMemberView: function(userId, device) {
            const addr = `${userId}.${device}`;
            return this.memberViews.get(addr);
        },

        getMemberViews: function() {
            return Array.from(this.memberViews.values());
        },

        findMemberViews: function(userId) {
            const results = [];
            for (const [key, value] of this.memberViews.entries()) {
                if (key.startsWith(userId)) {
                    results.push(value);
                }
            }
            return results;
        },

        addMemberView: function(userId, device) {
            const addr = `${userId}.${device}`;
            F.assert(!this.memberViews.has(addr));
            const order = (this.manager.members.findIndex(x => x.id === userId) << 16) + (device & 0xffff);
            const view = new F.CallMemberView({userId, device, order, callView: this});
            view.on('pinned', this.onMemberPinned.bind(this));
            if (view.outgoing) {
                view.on('silenced', this.onOutgoingMemberSilenced.bind(this));
            }
            this.memberViews.set(addr, view);
            this.$('.f-audience').append(view.$el);  // Might be noop if not rendered yet, which is fine.
            view.render();  // bg okay
            return view;
        },

        removeMemberView: function(view) {
            const addr = `${view.userId}.${view.device}`;
            F.assert(view === this.memberViews.get(addr));
            this.memberViews.delete(addr);
            if (view === this._presenting) {
                this._presenting = null;
                if (this.presenterView) {
                    this.selectPresenter(this.getMostPresentableMemberView());
                }
            }
            view.remove();
        },

        setCallStatus: function(value) {
            this._callStatus = value;
            this.$('.f-call-status').html(value);
        },

        addIncoming: function(addr, type) {
            this._incoming.add(addr);
            this._incomingTypes.add(type);
            if (this._clearIncomingTimeout) {
                clearTimeout(this._clearIncomingTimeout);
            }
            this._clearIncomingTimeout = setTimeout(() => this.clearIncoming(), 45 * 1000);
            this._updateIncoming();
        },

        removeIncoming: function(addr) {
            this._incoming.delete(addr);
            if (!this._incoming.size) {
                this._incomingTypes.clear();
                if (this._clearIncomingTimeout) {
                    clearTimeout(this._clearIncomingTimeout);
                    this._clearIncomingTimeout = null;
                }
            }
            this._updateIncoming();
        },

        clearIncoming: function() {
            this._incoming.clear();
            this._incomingTypes.clear();
            if (this._clearIncomingTimeout) {
                clearTimeout(this._clearIncomingTimeout);
                this._clearIncomingTimeout = null;
            }
            this._updateIncoming();
        },

        _updateIncoming: async function() {
            this.$el.toggleClass('incoming-call', !!this._incoming.size);
            const $status = this.$('.f-incoming .status');
            const type = this._incomingTypes.has('video') ? 'video' : 'audio';
            if (this._incoming.size === 1) {
                const addr = Array.from(this._incoming)[0];
                const user = await F.atlas.getContact(addr.split('.')[0]);
                $status.html(`Incoming ${type} call from ${user.getName()}...`);
            } else if (this._incoming.size > 1) {
                $status.html(`${this._incoming.size} incoming ${type} calls...`);
            } else {
                $status.empty();
            }
        },

        setJoined: function(joined) {
            joined = joined !== false;
            if (joined) {
                this._joined = this._joined || Date.now();
            } else {
                this._left = this._left || Date.now();
            }
            this.clearIncoming();
            this.$el.toggleClass('joined', joined);
        },

        join: async function(options) {
            options = options || {};
            if (this._joining) {
                logger.warn("Ignoring join request: already joining");
                return;
            }
            this._joining = true;
            const type = options.type;
            this.joinType = type || 'video';
            if (type === 'audio') {
                this.$el.addClass('audio-only');
                for (const t of this.outStream.getVideoTracks()) {
                    this.outStream.removeTrack(t);
                    t.stop();
                }
                this.outView.updateStream(this.outStream);
            }
            try {
                await this.manager.sendJoin({type});
                this.setJoined(true);
            } finally {
                this._joining = false;
            }
        },

        leave: async function(options) {
            options = options || {};
            if (!this.isJoined() || this._leaving) {
                logger.warn("Ignoring leave request: already left/leaving or not joined");
                return;
            }
            this._leaving = true;
            this.setJoined(false);
            try {
                await this.manager.sendLeave();
                for (const view of this.getMemberViews()) {
                    if (view.outgoing) {
                        continue;
                    }
                    this.removeMemberView(view);
                }
                this.joinType = null;
                if (!options.removing) {
                    await this.bindOutStream({reset: true});
                }
            } finally {
                this._leaving = false;
            }
        },

        remove: function() {
            clearInterval(this._pausedVideoWatch);
            clearInterval(this._soundCheckInterval);
            for (const [event, listener] of Object.entries(this._managerEvents)) {
                this.manager.removeEventListener(event, listener);
            }
            for (const [event, listener] of Object.entries(this._fullscreenEvents)) {
                document.removeEventListener(event, listener);
            }
            if (this.isFullscreen()) {
                F.util.exitFullscreen();  // bg okay
            }
            if (this._joined) {
                this.leave({removing: true}).then(() => {
                    const elapsed = moment.duration(this._left - this._joined);
                    this.model.createMessage({
                        type: 'clientOnly',
                        plain: `You were in a call for ${elapsed.humanize()}.`
                    });
                    this._cleanup();
                });
            } else {
                this._cleanup();
            }
            return F.View.prototype.remove.call(this);
        },
                                     
        remAudioButton: async function() {
            this.$('[data-type="audio"]').remove();
            this.$('.or').first().remove();
        },
        remVideoButton: async function() {
            this.$('[data-type="video"]').remove();
            this.$('.or').last().remove();
        },
        remScreenshareButton: async function() {
            this.$('[data-type="screenshare"]').remove();
            this.$('.or').last().remove();
        },

        _cleanup: function() {
            for (const track of this.outStream.getTracks()) {
                track.stop();
            }
            this.outStream = null;
            this.presenterView.remove();
            this.presenterView = null;
            for (const view of this.getMemberViews()) {
                this.removeMemberView(view);
            }
            this.outView = null;
            this.threadView.remove();
            this.threadView = null;
        },

        _getMediaDeviceVideoConstraints: async function() {
            const video = {};
            let videoRes = await F.state.get('callVideoResolution', 'auto');
            if (typeof videoRes === 'string' && videoRes !== 'auto') {
                logger.warn("Resetting legacy video resolution to auto");
                await F.state.put('callVideoResolution', 'auto');
                videoRes = 'auto';
            }
            if (videoRes !== 'auto') {
                const aspectRatio = videoRes < 720 ? (4 / 3) : (16 / 9);
                video.height = {ideal: videoRes};
                video.width = {ideal: Math.round(videoRes * aspectRatio)};
            }
            const videoFps = await F.state.get('callVideoFps', 'auto');
            if (videoFps !== 'auto') {
                video.frameRate = {ideal: videoFps};
            }
            const videoDevice = await F.state.get('callVideoDevice', 'auto');
            if (videoDevice !== 'auto') {
                video.deviceId = {ideal: videoDevice};
            }
            return Object.keys(video).length ? video : undefined;
        },

        _getMediaDeviceAudioConstraints: async function() {
            const audio = {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true,
            };
            const audioDevice = await F.state.get('callAudioInputDevice', 'auto');
            if (audioDevice !== 'auto') {
                audio.deviceId = {ideal: audioDevice};
            }
            return audio;
        },

        getOutStream: async function(options) {
            options = options || {};
            let stream;
            if (this.isScreenSharing()) {
                stream = await this.getScreenSharingStream();
                if (!stream && this.forceScreenSharing) {
                    stream = new MediaStream();
                }
            }
            if (!stream) {
                stream = await this.getDevicesStream(options);
            }
            if (this.isVideoMuted()) {
                for (const track of stream.getVideoTracks()) {
                    track.enabled = false;
                }
            }
            if (this.isAudioMuted()) {
                for (const track of stream.getAudioTracks()) {
                    track.enabled = false;
                }
            }
            return stream;

        },

        getDevicesStream: async function(options) {
            options = options || {};
            const md = navigator.mediaDevices;
            const availDevices = new Set(md && (await md.enumerateDevices()).map(x => x.kind));
            if (options.videoOnly) {
                availDevices.delete('audioinput');
            } else if (options.audioOnly) {
                availDevices.delete('videoinput');
            }
            const bestAudio = await this._getMediaDeviceAudioConstraints();
            const bestVideo = (await this._getMediaDeviceVideoConstraints()) || true;
            async function getUserMedia(constraints) {
                try {
                    return await md.getUserMedia(constraints);
                } catch(e) {
                    logger.warn("Could not get audio/video device:", e);
                }
            }
            let stream;
            if (availDevices.has('audioinput') && availDevices.has('videoinput')) {
                stream = await getUserMedia({audio: bestAudio, video: bestVideo});
            } else if (availDevices.has('audioinput')) {
                stream = await getUserMedia({audio: bestAudio});
                if (stream && !options.audioOnly) {
                    this.setCallStatus('<i class="icon yellow warning sign"></i> ' +
                                       'Video device not available.');
                }
            } else if (availDevices.has('videoinput')) {
                stream = await getUserMedia({video: bestVideo});
                if (stream && !options.videoOnly) {
                    this.setCallStatus('<i class="icon yellow warning sign"></i> ' +
                                       'Audio device not available.');
                }
            }
            if (!stream) {
                stream = new MediaStream();
                this.setCallStatus('<i class="icon red warning sign"></i> ' +
                                   'Video or audio device not available.');
            }
            return stream;
        },

        applyStreamConstraints: async function() {
            const video = await this._getMediaDeviceVideoConstraints();
            for (const track of this.outStream.getVideoTracks()) {
                track.applyConstraints(video);
            }
            const audio = await this._getMediaDeviceAudioConstraints();
            for (const track of this.outStream.getAudioTracks()) {
                track.applyConstraints(audio);
            }
        },

        bindOutStream: async function(options) {
            options = options || {};
            if (options.reset) {
                this.$el.removeClass('audio-only');
                if (!this.forceScreenSharing) {
                    this.$el.removeClass('screensharing');
                }
            }
            const stream = await this.getOutStream(options);
            if (this.outStream && this.outStream !== stream) {
                const tracks = new Set(stream.getTracks());
                for (const x of this.outStream.getTracks()) {
                    if (!tracks.has(x)) {
                        logger.warn("Stopping unused track:", x);
                        x.stop();
                    }
                }
            }
            this.outStream = stream;
            this.outView.updateStream(stream);
            for (const track of stream.getTracks()) {
                await this.replaceMembersOutTrack(track);
            }
        },

        checkSoundLevels: async function() {
            if (!this._presenting) {
                return;  // not rendered yet.
            }
            if (this._presenting.isPinned() ||
                (this._lastPresenterSwitch && Date.now() - this._lastPresenterSwitch < 2000)) {
                return;
            }
            const memberView = this.getMostPresentableMemberView();
            if (this._presenting !== memberView) {
                await this.selectPresenter(memberView);
                this._lastPresenterSwitch = Date.now();
            }
        },

        getMostPresentableMemberView: function() {
            const memberViews = new Set(this.getMemberViews());
            memberViews.delete(this.outView);
            if (memberViews.size === 0) {
                // Just us here, so I guess we are presenting ourselves.
                return this.outView;
            } else if (memberViews.size === 1) {
                // One on one, always present the peer.
                return Array.from(memberViews)[0];
            } else {
                // 2 or more remote peers.  Return the loudest one.
                let loudest = this._presenting !== this.outView ? this._presenting : null;
                for (const view of memberViews) {
                    if (!loudest || view.soundRMS - loudest.soundRMS >= 0.01) {
                        loudest = view;
                    }
                }
                return loudest;
            }
        },

        selectPresenter: async function(view) {
            if (this._presenting === view) {
                return;
            }
            if (this._presenting) {
                this._presenting.togglePresenting(false);
            }
            this._presenting = view;
            view.togglePresenting(true);
            await this.presenterView.select(view);
        },

        makePeerConnection: function(peerId, addr) {
            const peer = new ForstaRTCPeerConnection(peerId, addr, {iceServers: this.iceServers});
            const onICECandidate = F.buffered(async eventArgs => {
                const icecandidates = eventArgs.map(x => x[0].candidate).filter(x => x);
                if (!icecandidates.length) {
                    return;  // Only sentinel in buffered args, we're done.
                }
                logger.debug(`Sending ${icecandidates.length} ICE candidates to:`, peer.label);
                await this.manager.sendControlToDevice('callICECandidates', addr,
                                                       {icecandidates, peerId});
            }, 200, {max: 600});
            peer.addEventListener('icecandidate', onICECandidate);
            peer.addEventListener('icegatheringstatechange', ev => {
                logger.debug(`ICE Gathering State Change for: ${peer.label} ` +
                             `-> ${peer.iceGatheringState}`);
                if (peer.iceGatheringState === 'complete') {
                    onICECandidate.flush();  // Eliminate negotiation latency.
                }
            });
            peer.addEventListener('negotiationneeded', async ev => {
                logger.info("Negotiation needed: Sending offer to:", peer);
                await this.sendOffer(peer);
            });
            return peer;
        },

        sendOffer: async function(peer) {
            const offer = limitSDPBandwidth(await peer.createOffer(), await F.state.get('callIngressBps'));
            await peer.setLocalDescription(offer);
            logger.info(`Sending offer to:`, peer.label);
            await this.manager.sendControlToDevice('callOffer', peer.getMeta('addr'), {
                peerId: peer.getMeta('id'),
                offer: {
                    sdp: peer.localDescription.sdp,
                    type: peer.localDescription.type
                }
            });
        },

        isJoined: function() {
            return this.$el.hasClass('joined');
        },

        getFullscreenElement: function() {
            return document.body;
        },

        isFullscreen: function() {
            const el = F.util.fullscreenElement();
            return !!(el && el === this.getFullscreenElement());
        },

        isDetached: function() {
            return this.$el.hasClass('detached');
        },

        isScreenSharing: function() {
            return this.$el.hasClass('screensharing');
        },

        isVideoMuted: function() {
            return this.$el.hasClass('video-muted');
        },

        isAudioMuted: function() {
            return this.$el.hasClass('audio-muted');
        },

        isThreadVisible: function() {
            const $threadEl = this.$('.f-thread');
            return !$threadEl.hasClass('collapsed') && !$threadEl.is(':hidden');
        },

        toggleDetached: async function(detached) {
            detached = detached === undefined ? !this.isDetached() : detached !== false;
            this.$el.toggleClass('detached', detached);
            if (!detached) {
                // Clear any fixed positioning from moving...
                this.$el.css({top: '', left: '', right: '', bottom: ''});
            }
            await this.render();
        },

        replaceMembersOutTrack: async function(track) {
            for (const view of this.memberViews.values()) {
                for (const peer of view.getPeers()) {
                    let replaced;
                    for (const t of peer.getTransceivers()) {
                        const recvTrackKind = t.receiver && t.receiver.track && t.receiver.track.kind;
                        if (!t.stopped && recvTrackKind === track.kind) {
                            logger.info("Replacing sender track with:", track);
                            t.direction = 'sendrecv';
                            await t.sender.replaceTrack(track);
                            replaced = true;
                        }
                    }
                    if (!replaced) {
                        throw new Error('No transceivers found to replace sender track on');
                    }
                }
            }
        },

        removeMembersOutTrack: async function(kind) {
            for (const view of this.memberViews.values()) {
                for (const peer of view.getPeers()) {
                    for (const t of peer.getTransceivers()) {
                        if (!t.stopped && t.sender && t.sender.track && t.sender.track.kind === kind) {
                            logger.warn(`Removing ${kind} track:`, t.sender.track);
                            t.direction = 'recvonly';
                            await t.sender.replaceTrack(null);
                        }
                    }
                }
            }
        },

        enqueueEarlyICECandidates: function(peerId, icecandidates) {
            const bucket = this._earlyICECandidates.get(peerId);
            bucket.push.apply(bucket, icecandidates);
        },

        drainEarlyICECandidates: function(peerId) {
            if (!this._earlyICECandidates.has(peerId)) {
                return;
            }
            const bucket = this._earlyICECandidates.get(peerId);
            this._earlyICECandidates.delete(peerId);
            return bucket;
        },

        onPeerOffer: async function(ev) {
            F.assert(ev.data.callId === this.manager.callId);
            const view = this.getMemberView(ev.sender, ev.device) ||
                         this.addMemberView(ev.sender, ev.device);
            const addr = `${ev.sender}.${ev.device}`;
            logger.info('Peer sent us a call-offer:', addr);
            await view.acceptOffer(ev.data);
        },

        onPeerAcceptOffer: async function(ev) {
            F.assert(ev.data.callId === this.manager.callId);
            const addr = `${ev.sender}.${ev.device}`;
            if (!this.isJoined()) {
                logger.warn("Dropping peer accept offer while not joined:", addr);
            }
            const view = this.getMemberView(ev.sender, ev.device);
            if (!view) {
                logger.error("Peer accept offer from non-member:", addr);
                return;
            }
            await view.handlePeerAcceptOffer(ev.data);
        },

        onPeerICECandidates: async function(ev) {
            F.assert(ev.data.callId === this.manager.callId);
            const peerId = ev.data.peerId;
            F.assert(peerId);
            const addr = `${ev.sender}.${ev.device}`;
            const label = ForstaRTCPeerConnection.makeLabel(peerId, addr);
            if (!this.isJoined()) {
                logger.warn(`Queuing ICE candidates while not joined:`, label);
                this.enqueueEarlyICECandidates(peerId, ev.data.icecandidates);  // paranoid
                return;
            }
            const view = this.getMemberView(ev.sender, ev.device);
            const peer = view && view.getPeer(peerId);
            if (!peer || !peer.remoteDescription) {
                logger.warn(`Queuing ICE candidates for:`, label);
                this.enqueueEarlyICECandidates(peerId, ev.data.icecandidates);
            } else {
                logger.debug(`Adding ${ev.data.icecandidates.length} ICE candidates for:`, label);
                await Promise.all(ev.data.icecandidates.map(x =>
                    peer.addIceCandidate(new RTCIceCandidate(x))));
            }
        },

        onPeerJoin: async function(ev) {
            const addr = `${ev.sender}.${ev.device}`;
            if (!this.isJoined()) {
                logger.info("Treating peer-join as an incoming call request:", addr);
                this.addIncoming(addr, ev.joinType);
                return;
            }
            logger.info('Peer is joining call:', addr);
            const view = this.getMemberView(ev.sender, ev.device) ||
                         this.addMemberView(ev.sender, ev.device);
            await view.establish();
        },

        onPeerLeave: async function(ev) {
            const addr = `${ev.sender}.${ev.device}`;
            logger.warn('Peer left call:', addr);
            if (!this.isJoined()) {
                this.removeIncoming(addr);
                return;
            }
            const view = this.getMemberView(ev.sender, ev.device);
            if (!view) {
                logger.warn("Dropping peer-leave from detached peer:", addr);
                return;
            }
            this.removeMemberView(view);
            F.util.playAudio('/audio/call-leave.mp3');  // bg okay
            if (this.memberViews.size === 1) {
                logger.warn("Last peer member left: Leaving call...");
                await this.leave();
            }
        },

        onLeaveClick: async function() {
            const $button = this.$('.f-leave.button');
            $button.addClass('loading');
            try {
                if (this.isJoined()) {
                    await this.leave();
                    F.util.playAudio('/audio/call-leave.mp3');  // bg okay
                } else {
                    throw new Error("Invalid call state for leave");
                }
            } finally {
                $button.removeClass('loading');
            }
        },

        onJoinClick: async function(ev) {
            const $button = $(ev.currentTarget);
            const type = $button.data('type');
            if (this.isJoined()) {
                throw new Error("Invalid call state for join");
            }
            if (type === 'screenshare') {
                if (await this.startScreenSharing() === false) {
                    return;
                }
            }
            if (!this._incoming.size && !this.model.hasRecentCallActivity()) {
                F.util.playAudio('/audio/call-dial.mp3');  // bg okay
            }
            await this.join({type});
        },

        onIncomingAcceptClick: function(ev) {
            const type = this._incomingTypes.has('video') ? 'video' : 'audio';
            this.clearIncoming();
            this.join({type});
        },

        onIncomingIgnoreClick: function(ev) {
            this.clearIncoming();
        },

        onThreadToggleClick: function(ev) {
            this.$('.f-thread').toggleClass('collapsed');
            this.$('.f-thread-toggle .icon').toggleClass('right left');
        },

        onShareClick: async function(ev) {
            this.shareLink = await F.util.shareThreadLink(this.model, {call: true, skipPrompt: true});
            const $shareLink = this.$('.f-share-link');
            $shareLink.html(this.shareLink);
            F.util.selectElements($shareLink);
            if (navigator.share) {
                await navigator.share({
                    title: "Share this call",
                    text: "Use this url to add others to the call",
                    url: this.shareLink
                });
            } else if (navigator.clipboard) {
                await navigator.clipboard.writeText(this.shareLink);
                $shareLink.addClass('copied');
                // clear confirmation if clipboard changes.
                for (const ev of ['cut', 'copy']) {
                    addEventListener(ev, () => $shareLink.removeClass('copied'), {once: true});
                }
            }
        },

        onVideoMuteClick: async function(ev) {
            await this.setVideoMuted(!this.isVideoMuted());
        },

        onAudioMuteClick: function(ev) {
            if (!this.outStream) {
                logger.warn("No outgoing stream to mute");
            }
            const mute = !this.isAudioMuted();
            this.$el.toggleClass('audio-muted', mute);
            this.outView.toggleSilenced(mute);
        },

        onScreenShareClick: async function() {
            if (this.isScreenSharing()) {
                await this.stopScreenSharing();
            } else {
                await this.startScreenSharing();
            }
        },

        onDetachClick: async function(ev) {
            await this.toggleDetached();
        },

        onFullscreenClick: async function(ev) {
            if (this.isFullscreen()) {
                await F.util.exitFullscreen();
            } else {
                const detached = this.isDetached();
                try {
                    await F.util.requestFullscreen(this.getFullscreenElement());
                } catch(e) {
                    logger.warn("Could not enter fullscreen:", e);
                    return;
                }
                this._detachedBeforeFullscreen = detached;
                if (detached) {
                    // Must do this after the fullscreen request to avoid permission issue.
                    await this.toggleDetached(false);
                }
            }
        },

        onFullscreenChange: async function() {
            if (this.isFullscreen()) {
                this._fullscreenActive = true;
            } else if (this._fullscreenActive) {
                this._fullscreenActive = false;
                if (this._detachedBeforeFullscreen) {
                    await this.toggleDetached(true);
                }
            }
        },

        onCloseClick: function() {
            this.remove();
            this.trigger('close', this);
        },

        onSettingsSelect: async function() {
            const view = new F.CallSettingsView({callView: this});
            await view.show();
        },

        onShareLinkSelect: async function() {
            await F.util.shareThreadLink(this.model, {call: true});
        },

        onHeaderPointerDown: function(ev) {
            // Support for moving detached view.
            if (!this.$el.hasClass('detached') || $(ev.target).closest(this.$('> header .buttons')).length) {
                return;
            }
            const width = this.el.offsetWidth;
            const height = this.el.offsetHeight;
            const offsetX = width - (ev.pageX - this.el.offsetLeft);
            const offsetY = height - (ev.pageY - this.el.offsetTop);
            const margin = 6;  // px
            const bodyWidth = document.body.offsetWidth;
            const bodyHeight = document.body.offsetHeight;
            const maxRight = bodyWidth - width - margin;
            const maxBottom = bodyHeight - height - margin;
            this.$el.addClass('moving');
            //const right = Math.max(margin, Math.min(maxRight, cursorRight - offsetX));
            //const bottom = Math.max(margin, Math.min(maxBottom, cursorBottom - offsetY));
            //this.el.style.setProperty('bottom', `${bottom}px`);
            //this.el.style.setProperty('right', `${right}px`);

            const onMove = async ev => {
                await F.util.animationFrame();
                const cursorRight = bodyWidth - ev.clientX;
                const cursorBottom = bodyHeight - ev.clientY;
                const right = Math.max(margin, Math.min(maxRight, cursorRight - offsetX));
                const bottom = Math.max(margin, Math.min(maxBottom, cursorBottom - offsetY));
                this.el.style.setProperty('bottom', `${bottom}px`);
                this.el.style.setProperty('right', `${right}px`);
            };
            document.addEventListener('pointerup', ev => {
                this.$el.removeClass('moving');
                document.removeEventListener('pointermove', onMove);
            }, {once: true});
            document.addEventListener('pointermove', onMove);
        },

        onHeaderDoubleClick: async function(ev) {
            await this.toggleDetached();
        },

        onAddThreadMessage: async function(msg) {
            // TODO: Handle message replies too.
            if (this.isThreadVisible() || !msg.get('incoming')) {
                return;
            }
            const msgView = await this.threadView.messagesView.waitAdded(msg);
            await msgView.rendered;
            const $msg = msgView.$el.clone();
            $msg.addClass('f-hover-message').removeClass('merge-with-prev merge-with-next');
            this.$('.f-hover-messages').append($msg);
            $msg.transition('fade in up');
            setTimeout(() => {
                $msg.transition({animation: 'fade out down', onComplete: () => $msg.remove()});
            }, 5000);
        },

        setVideoMuted: async function(mute) {
            this.$el.toggleClass('video-muted', mute);
            const videoTracks = this.outStream.getVideoTracks();
            F.assert(videoTracks.length <= 1, 'Too many video tracks in outStream');
            const track = videoTracks[0];
            if (track) {
                track.enabled = !mute;
            }
            if (mute) {
                await this.removeMembersOutTrack('video');
            } else if (track) {
                await this.replaceMembersOutTrack(track);
            }
        },

        startScreenSharing: async function() {
            const stream = await this.getScreenSharingStream();
            if (!stream) {
                return false;
            }
            /* Reuse existing streams to avoid peer rebinding. */
            const tracks = stream.getTracks();
            F.assert(tracks.length === 1);
            const track = tracks[0];
            F.assert(track.kind === 'video');
            for (const x of this.outStream.getVideoTracks()) {
                this.outStream.removeTrack(x);
                x.stop();
            }
            this.outStream.addTrack(track);
            this.outView.updateStream(this.outStream);
            const outStreamClosure = this.outStream;
            track.addEventListener('ended', async () => {
                if (this.outStream !== outStreamClosure) {
                    logger.warn("Ignoring track ended event for stale outStream");
                    return;
                }
                await this.removeScreenShareTrack(track);
            });
            this.$el.addClass('screensharing');
            await this.replaceMembersOutTrack(track);
        },

        removeScreenShareTrack: async function(track) {
            this.$el.removeClass('screensharing');
            this.outStream.removeTrack(track);
            track.stop();
            let videoTrack;
            if (!this.forceScreenSharing && this.joinType !== 'audio') {
                const replacementStream = await this.getOutStream({videoOnly: true});
                videoTrack = replacementStream.getVideoTracks()[0];
            }
            if (videoTrack) {
                this.outStream.addTrack(videoTrack);
                await this.replaceMembersOutTrack(videoTrack);
            } else {
                await this.removeMembersOutTrack('video');
            }
            this.outView.updateStream(this.outStream);
        },

        getScreenSharingStream: async function() {
            const md = navigator.mediaDevices;
            const browser = platform.name.toLowerCase();
            let stream;
            try {
                if (md.getDisplayMedia) {
                    // New stuff is fully native with this new call! Chrome 72+ and FF66+
                    logger.info("Using new getDisplayMedia for screensharing.");
                    const video = await this._getMediaDeviceVideoConstraints();
                    if (video) {
                        delete video.deviceId;
                    }
                    stream = await md.getDisplayMedia({video});
                } else if (browser === 'firefox') {
                    // old firefox
                    logger.info("Using firefox native screensharing.");
                    stream = await md.getUserMedia({video: {mediaSource: 'screen'}});
                } else if (browser === 'chrome') {
                    if (await hasChromeScreenSharingExt()) {
                        logger.info("Using chrome ext screensharing.");
                        const sourceId = await requestChromeScreenSharing();
                        stream = await md.getUserMedia({
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: sourceId
                                }
                            }
                        });
                    } else {
                        F.util.promptModal({
                            size: 'tiny',
                            allowMultiple: true,
                            header: 'Chrome Extension Required',
                            content: 'For security reasons Chrome does not allow screen sharing without ' +
                                     'a specialized browser extension...<br/><br/> ' +
                                     'Add the extension from the Chrome Web Store and reload this page. ' +
                                     `<a target="_blank" href="${chromeExtUrl}">` +
                                     `<img class="ui image small" src="${chromeWebStoreImage}"/></a>`
                        });
                    }
                } else {
                    F.util.promptModal({
                        size: 'tiny',
                        allowMultiple: true,
                        header: 'Unsupported Browser',
                        content: 'Screen sharing is not supported on this device.'
                    });
                }
            } catch(e) {
                const userHitCancel = 'NotAllowedError';
                if (e.name !== userHitCancel && e !== 'Error: Permission Denied') {
                    logger.error("Failed to get screenshare device:", e);
                    F.util.promptModal({
                        size: 'tiny',
                        allowMultiple: true,
                        header: 'Screen Share Error',
                        content: `Failed to get screen sharing device: <pre>${e}</pre>`
                    });
                }
            }
            return stream;
        },

        stopScreenSharing: async function() {
            for (const x of Array.from(this.outStream.getVideoTracks())) {
                await this.removeScreenShareTrack(x);
                this.outStream.removeTrack(x);
                x.stop();
            }
            this.outView.updateStream(this.outStream);
        },

        onMemberPinned: async function(view, pinned) {
            if (pinned) {
                for (const x of this.memberViews.values()) {
                    if (x !== view) {
                        x.togglePinned(false);
                        if (x.videoEl && x.videoEl.paused) {
                            logger.warn("Attempting to resume paused video...", x.videoEl);
                            x.videoEl.play().catch(() => 0); // XXX workaround chrome bug
                        }
                    }
                }
                await this.selectPresenter(view);
            }
        },

        onOutgoingMemberSilenced: async function(view, silenced) {
            this.$el.toggleClass('audio-muted', silenced);
        }
    });


    F.CallMemberView = F.View.extend({

        template: 'views/call-member.html',
        className: 'f-call-member-view',

        events: {
            'click': 'onClick'
        },

        initialize: function(options) {
            F.assert(options.userId);
            F.assert(options.device);
            F.assert(options.callView);
            F.assert(options.order != null);
            this.userId = options.userId;
            this.device = options.device;
            this.addr = `${this.userId}.${this.device}`;
            this.callView = options.callView;
            this.soundRMS = -1;
            this._peers = new Map();
            this.streamChanged = Date.now();
            this.outgoing = this.userId === F.currentUser.id && this.device === F.currentDevice;
            if (this.outgoing) {
                this.$el.addClass('outgoing');
            } else {
                this._peerCheckInterval = setInterval(this.peerCheck.bind(this), 1000);
            }
            this.$el.css('order', options.order);
            F.View.prototype.initialize(options);
        },

        peerCheck: async function() {
            const peers = this.getPeers();
            for (const peer of peers) {
                const stats = [];
                for (const x of peer.getTransceivers()) {
                    if (x.sender && x.sender.track) {
                        stats.push({
                            track: x.sender.track,
                            direction: 'send',
                            data: await peer.getStats(x.sender.track),
                        });
                    }
                    stats.push({
                        track: x.receiver.track,
                        direction: 'recv',
                        data: await peer.getStats(x.receiver.track),
                    });
                }
                this.trigger("peerstats", peer, stats);
            }
            if (this._peerActionTimeout) {
                return;
            }
            if (peers.length === 0) {
                this._schedPeerActionSoon(() => {
                    if (this.getPeers().length === 0) {
                        if (Date.now() - this.streamChanged > 60000) {
                            logger.warn("Dropping unavailable member:", this.addr);
                            this.callView.removeMemberView(this);
                        } else {
                            logger.warn("Creating new peer connection offer for:", this.addr);
                            this.establish();
                        }
                    }
                });
            } else {
                for (const peer of peers.filter(x => x.isStale())) {
                    this._schedPeerActionSoon(() => {
                        if (!peer.isConnected()) {
                            logger.warn(`Removing stale connection:`, peer.label);
                            this.removePeer(peer);
                        }
                    });
                }
                const connected = peers.filter(x => x.isConnected());
                if (connected.length && !this.streamingPeer) {
                    const newest = connected[connected.length - 1];
                    logger.warn(`Binding media stream to newest connection:`, newest.label);
                    this.updateStream(newest.getMeta('stream'), newest);
                }
                if (connected.length > 1) {
                    for (const peer of connected) {
                        if (peer !== this.streamingPeer) {
                            this._schedPeerActionSoon(() => {
                                if (peer !== this.streamingPeer) {
                                    logger.warn(`Removing redundant connection:`, peer.label);
                                    this.removePeer(peer);
                                }
                            });
                            break;  // Only one at a time, slow gc avoids interruptions
                        }
                    }
                }
            }
        },

        _schedPeerActionSoon: function(callback) {
            this._peerActionTimeout = setTimeout(async () => {
                try {
                    await callback();
                } finally {
                    this._peerActionTimeout = null;
                }
            }, 1000 + (Math.random() * 3000));
        },

        render_attributes: async function() {
            const user = await F.atlas.getContact(this.userId);
            return {
                name: user.getName(),
                tagSlug: user.getTagSlug(),
                avatar: await user.getAvatar({
                    size: 'large',
                    allowMultiple: true
                }),
                outgoing: this.outgoing,
            };
        },

        render: async function() {
            this.$soundIndicators = null;
            this.videoEl = null;
            await F.View.prototype.render.call(this);
            this.videoEl = this.$('video')[0];
            if (!this.outgoing && canAssignAudioOutput) {
                let outputDevice = await F.state.get('callAudioOutputDevice');
                if (!outputDevice || outputDevice === 'auto') {
                    outputDevice = '';
                } else {
                    logger.info("Setting audio output device to:", outputDevice);
                }
                try {
                    await this.videoEl.setSinkId(outputDevice);
                } catch(e) {
                    logger.error('Failed to set output audio device sink:', e);
                }
            }
            this.$soundIndicators = this.$('.f-soundlevel .f-indicator');
            this.updateStream(this.stream, this.streamingPeer);
            return this;
        },

        remove: function() {
            if (!this.outgoing) {
                clearInterval(this._peerCheckInterval);
                for (const x of this.getPeers()) {
                    this.removePeer(x);
                }
            }
            return F.View.prototype.remove.call(this);
        },

        onClick: function() {
            this.togglePinned(true);
        },

        togglePinned: function(pinned) {
            pinned = pinned === undefined ? !this.isPinned() : pinned !== false;
            this.$el.toggleClass('pinned', !!pinned);
            this.trigger('pinned', this, pinned);
        },

        toggleSilenced: function(silenced) {
            silenced = silenced === undefined ? !this.isSilenced() : silenced !== false;
            this.$el.toggleClass('silenced', !!silenced);
            if (this.stream) {
                for (const track of this.stream.getAudioTracks()) {
                    track.enabled = !silenced;
                }
            }
            this.trigger('silenced', this, silenced);
        },

        togglePresenting: function(presenting) {
            this.$el.toggleClass('presenting', presenting);
        },

        setStatus: function(status) {
            status = status || '';
            this._status = status;
            if (this._rendered) {
                const $circle = this.$('.f-status-circle');
                const addClass = $circle.data(status.toLowerCase() || 'empty');
                F.assert(addClass !== undefined, `Missing status bubble data attr for: ${status}`);
                $circle.attr('class', $circle.data('baseClass') + ' ' + addClass);
                $circle.attr('title', status);
            }
            this.trigger('statuschanged', this, status);
        },

        getStatus: function() {
            return this._status;
        },

        setAudioOnly: function(audioOnly) {
            audioOnly = audioOnly !== false;
            this.$el.toggleClass('audio-only', audioOnly);
            this.trigger('audioonly', this, audioOnly);
        },

        isAudioOnly: function() {
            return this.$el.hasClass('audio-only');
        },

        setStreaming: function(streaming, options) {
            streaming = streaming !== false;
            options = options || {};
            this.$el.toggleClass('streaming', streaming);
            this.trigger('streaming', this, streaming);
        },

        isStreaming: function() {
            return this.$el.hasClass('streaming');
        },

        isPinned: function() {
            return this.$el.hasClass('pinned');
        },

        isSilenced: function() {
            return this.$el.hasClass('silenced');
        },

        hasConnectedPeer: function() {
            return this.getPeers().some(x => x.isConnected());
        },

        hasPeers: function() {
            return !!this._peers.size;
        },

        getPeers: function() {
            return Array.from(this._peers.values());
        },

        addPeer: function(id, peer) {
            this._peers.set(id, peer);
            peer.setMeta('added', Date.now());
        },

        getPeer: function(id) {
            return this._peers.get(id);
        },

        removePeer: function(peer) {
            const entries = Array.from(this._peers.entries());
            const entry = entries.find(([key, val]) => val === peer);
            if (!entry) {
                logger.error("Peer already removed:", peer);
                return;
            }
            if (this.streamingPeer === peer) {
                this.removeStream();
            }
            this.unbindPeer(peer);
            const id = entry[0];
            this._peers.delete(id);
            for (const x of peer.getReceivers()) {
                x.track.stop();
            }
            peer.close();
        },

        sendPeerControl: async function(control, data) {
            await this.callView.manager.sendControlToDevice(control, this.addr, data);
        },

        throttledVolumeIndicate: _.throttle(function() {
            if (!this.$soundIndicators || !this.$soundIndicators.length) {
                return;
            }
            const loudness = Math.min(1, Math.max(0, volumeLoudness(this.soundDBV)));
            this.$soundIndicators.css('width', Math.round(loudness * 100) + '%');
        }, 1000 / 15),

        updateStream: function(stream, peer) {
            F.assert(stream == null || stream instanceof MediaStream);
            if (stream !== this.stream) {
                this.streamChanged = Date.now();
            }
            this.stream = stream;
            this.streamingPeer = peer;
            if (!stream) {
                this.removeStream();
                return;
            }
            const silenced = this.isSilenced();
            let hasAudio = false;
            let hasVideo = false;
            for (const track of stream.getTracks()) {
                if (track.kind === 'audio' && silenced) {
                    track.enabled = false;
                }
                if (track.kind === 'audio') {
                    hasAudio = track.enabled && !track.muted;
                } else if (track.kind === 'video') {
                    hasVideo = track.enabled && !track.muted;
                }
            }
            const hasMedia = hasVideo || (hasAudio && !this.outgoing);
            this.soundRMS = -1;
            this.soundDBV = -100;
            let soundMeter;
            if (hasAudio) {
                if (!this.soundMeter || this.soundMeter.source.mediaStream !== stream) {
                    if (this.soundMeter) {
                        this.soundMeter.disconnect();
                    }
                    soundMeter = new SoundMeter(stream, levels => {
                        if (this.soundMeter !== soundMeter) {
                            return;
                        }
                        this.soundRMS = levels.averageRms;
                        this.soundDBV = levels.averageDBV;
                        this.trigger('soundlevel', levels);
                        this.throttledVolumeIndicate.call(this);
                    });
                } else {
                    soundMeter = this.soundMeter;  // no change
                }
            } else if (this.soundMeter) {
                this.soundMeter.disconnect();
            }
            this.soundMeter = soundMeter;
            if (this.videoEl) {
                const srcObject = hasMedia ? this.stream : null;
                if (this.videoEl.srcObject !== srcObject) {
                    this.videoEl.srcObject = srcObject;
                }
            }
            this.trigger('streamupdate', this, this.stream);
            const streaming = this.outgoing ? hasMedia : (hasMedia && (!peer || peer.isConnected()));
            this.setAudioOnly(hasAudio && !hasVideo);
            this.setStreaming(streaming);
        },

        removeStream: function(options) {
            options = options || {};
            this.streamingPeer = null;
            if (this.isStreaming()) {
                this.setStreaming(false, {silent: options.silent});
            }
            if (this.isAudioOnly()) {
                this.setAudioOnly(false, {silent: options.silent});
            }
            if (this.soundMeter) {
                this.soundMeter.disconnect();
                this.soundMeter = null;
                this.soundRMS = -1;
                this.soundDBV = -100;
            }
            if (this.stream) {
                this.streamChanged = Date.now();
                this.stream = null;
            }
            if (this.videoEl) {
                this.videoEl.srcObject = null;
            }
            this.trigger('streamupdate', this, null);
        },

        bindPeer: function(id, peer) {
            F.assert(peer instanceof ForstaRTCPeerConnection);
            if (peer._viewListeners) {
                return;
            }
            const stream = peer.getMeta('stream');
            const addedTracks = new Set();
            const endedTracks = new Set();
            peer._viewListeners = {
                iceconnectionstatechange: ev => {
                    // NOTE: eventually we should switch to connectionstatechange when browser
                    // support becomes available.  Right now chrome doesn't have it, maybe others.
                    // Also don't trust MDN on this, they wrongly claim it is supported since M56.
                    F.assert(this.getPeer(id), 'peer is stale');
                    const state = peer.iceConnectionState;
                    if (peer.isConnected()) {
                        peer.setMeta('connected', Date.now());
                    }
                    if (this.streamingPeer !== peer) {
                        logger.warn(`Ignoring ICE state change for inactive connection: ` +
                                    `${peer.label} -> ${state}`);
                        return;
                    }
                    logger.debug(`Peer ICE connection: ${peer.label} -> ${state}`);
                    this.setStatus(state);
                    this.updateStream(stream, peer);
                },
                track: ev => {
                    F.assert(this.getPeer(id), 'peer is stale');
                    const track = ev.track;
                    F.assert(!endedTracks.has(track));
                    if (addedTracks.has(track)) {
                        // XXX Understand why this happens (seems to be safari only right now).
                        logger.error("Track event for already added track:", track);
                        return;
                    }
                    ev.track.addEventListener('ended', () => {
                        logger.warn("Stream track ended, removing:", track);
                        F.assert(!endedTracks.has(track));
                        stream.removeTrack(track);
                        endedTracks.add(track);
                        this.updateStream(stream, peer);
                    });
                    ev.track.addEventListener('mute', () => {
                        logger.warn("Track <red>MUTED</red>:", track);
                        F.assert(!endedTracks.has(track));
                        this.updateStream(stream, peer);
                    });
                    ev.track.addEventListener('unmute', () => {
                        logger.info("Track <green>UNMUTED</green>:", track);
                        F.assert(!endedTracks.has(track));
                        this.updateStream(stream, peer);
                    });
                    addedTracks.add(track);
                    stream.addTrack(track);
                    this.updateStream(stream, peer);
                }
            };
            for (const [ev, cb] of Object.entries(peer._viewListeners)) {
                peer.addEventListener(ev, cb);
            }
            this.updateStream(stream, peer);
        },

        unbindPeer: function(peer) {
            if (!peer._viewListeners) {
                return;
            }
            for (const [ev, cb] of Object.entries(peer._viewListeners)) {
                peer.removeEventListener(ev, cb);
            }
            peer._viewListeners = null;
        },

        addTracksToPeer: function(peer) {
            F.assert(!peer.getMeta('tracksAdded'));
            peer.setMeta('tracksAdded', true);
            const tracks = this.callView.outStream.getTracks();
            const addedKinds = new Set();
            for (const track of tracks) {
                if (track.enabled) {  // not enabled = video muted
                    peer.addTrack(track, this.callView.outStream);
                    F.assert(!addedKinds.has(track.kind));
                    addedKinds.add(track.kind);
                }
            }
            const requiredKinds = new Set(['audio']);
            if (this.callView.joinType !== 'audio') {
                requiredKinds.add('video');
            }
            for (const kind of requiredKinds) {
                if (!addedKinds.has(kind)) {
                    logger.warn(`No outgoing ${kind} track available.`);
                    let hasReceiver;
                    for (const t of peer.getTransceivers()) {
                        if (!t.stopped && t.receiver && t.receiver.track && t.receiver.track.kind === kind) {
                            hasReceiver = true;
                            break;
                        }
                    }
                    if (!hasReceiver) {
                        logger.warn(`Adding recv-only ${kind} transceiver for:`, peer);
                        peer.addTransceiver(kind, {direction: 'recvonly'});
                    }
                }
            }
        },

        establish: async function() {
            await F.queueAsync(`call-establish-${this.addr}`, async () => {
                this.setStatus();
                clearTimeout(this.offeringTimeout);
                const peerId = F.util.uuid4();
                const peer = this.callView.makePeerConnection(peerId, this.addr);
                this.addPeer(peerId, peer);
                this.setStatus('Calling');
                this.addTracksToPeer(peer);
                this.offeringTimeout = setTimeout(() => this.setStatus('Unavailable'), 30000);
            });
        },

        acceptOffer: async function(data) {
            await F.queueAsync(`call-accept-offer-${this.addr}`, async () => {
                let peer = this.getPeer(data.peerId);
                let newPeer = !peer;
                if (newPeer) {
                    logger.info("Creating new peer connection for:", this.addr);
                    peer = this.callView.makePeerConnection(data.peerId, this.addr);
                    this.addPeer(data.peerId, peer);
                    this.bindPeer(data.peerId, peer);
                } else {
                    logger.info("Renegotiation needed for existing peer connection:", this.addr);
                }
                await peer.setRemoteDescription(limitSDPBandwidth(data.offer, await F.state.get('callEgressBps')));
                F.assert(peer.remoteDescription.type === 'offer');
                if (newPeer) {
                    this.addTracksToPeer(peer);
                }
                const earlyICECandidates = this.callView.drainEarlyICECandidates(data.peerId);
                if (earlyICECandidates) {
                    F.assert(earlyICECandidates.length);
                    logger.debug(`Adding ${earlyICECandidates.length} early ICE candidates for:`,
                                 peer.label);
                    await Promise.all(earlyICECandidates.map(x =>
                        peer.addIceCandidate(new RTCIceCandidate(x))));
                }
                const answer = limitSDPBandwidth(await peer.createAnswer(), await F.state.get('callIngressBps'));
                await peer.setLocalDescription(answer);
                logger.info("Accepting call offer from:", this.addr);
                this.sendPeerControl('callAcceptOffer', {
                    peerId: data.peerId,
                    answer: {
                        type: peer.localDescription.type,
                        sdp: peer.localDescription.sdp
                    }
                });  // bg okay
            });
        },

        handlePeerAcceptOffer: async function(data) {
            const peer = this.getPeer(data.peerId);
            if (!peer) {
                const label = ForstaRTCPeerConnection.makeLabel(data.peerId, this.addr);
                logger.warn(`Peer accepted offer we rescinded:`, label);
                return;
            }
            logger.info(`Peer accepted our call offer:`, peer.label);
            const isNew = peer.iceConnectionState === 'new';
            clearTimeout(this.offeringTimeout);
            this.bindPeer(data.peerId, peer);
            await peer.setRemoteDescription(limitSDPBandwidth(data.answer, await F.state.get('callEgressBps')));
            const earlyICECandidates = this.callView.drainEarlyICECandidates(data.peerId);
            if (earlyICECandidates) {
                F.assert(earlyICECandidates.length);
                logger.debug(`Adding ${earlyICECandidates.length} early ICE candidate(s) for:`, this.addr);
                await Promise.all(earlyICECandidates.map(x =>
                    peer.addIceCandidate(new RTCIceCandidate(x))));
            }
            if (isNew) {
                F.util.playAudio('/audio/call-peer-join.mp3');  // bg okay
            }
        },
    });


    F.CallPresenterView = F.View.extend({

        template: 'views/call-presenter.html',
        className: 'f-call-presenter-view',

        events: {
            'click .f-silence':  'onSilenceClick',
            'click .f-fullscreen-video': 'onFullscreenVideoClick',
            'click .f-popout': 'onPopoutClick'
        },

        initialize: function(options) {
            F.assert(options.callView);
            this.callView = options.callView;
            F.View.prototype.initialize(options);
        },

        render_attributes: async function() {
            if (!this.memberView) {
                return {};
            }
            const user = await F.atlas.getContact(this.memberView.userId);
            return {
                userId: user.id,
                name: user.id === F.currentUser.id ? '[You]' : user.getName(),
                tagSlug: user.getTagSlug(),
                avatar: await user.getAvatar({
                    size: 'large',
                    allowMultiple: true
                }),
                outgoing: this.memberView.outgoing,
                status: this.memberView.getStatus(),
                canFullscreen,
                canPopout,
                shareLink: this.callView.shareLink,
            };
        },

        render: async function() {
            this.$soundIndicators = null;
            this.videoEl = null;
            this.$el.toggleClass('outgoing', !!this.memberView.outgoing);
            await F.View.prototype.render.call(this);
            this.videoEl = this.$('video')[0];
            this.$soundIndicators = this.$('.f-soundlevel .f-indicator');
            return this;
        },

        select: async function(view) {
            F.assert(view instanceof F.CallMemberView);
            if (view !== this.memberView) {
                if (this.memberView) {
                    this.stopListening(this.memberView, 'streamupdate');
                    this.stopListening(this.memberView, 'streaming');
                    this.stopListening(this.memberView, 'audioonly');
                    this.stopListening(this.memberView, 'pinned');
                    this.stopListening(this.memberView, 'silenced');
                    this.stopListening(this.memberView, 'statuschanged');
                    this.stopListening(this.memberView, 'soundlevel');
                    this.stopListening(this.memberView, 'peerstats');
                }
                this.memberView = view;
                this.listenTo(view, 'streamupdate', this.onMemberStreamUpdate);
                this.listenTo(view, 'streaming', this.onMemberStreaming);
                this.listenTo(view, 'audioonly', this.onMemberAudioOnly);
                this.listenTo(view, 'pinned', this.onMemberPinned);
                this.listenTo(view, 'silenced', this.onMemberSilenced);
                this.listenTo(view, 'statuschanged', this.onMemberStatusChanged);
                this.listenTo(view, 'soundlevel', this.onMemberSoundLevel);
                this.listenTo(view, 'peerstats', this.onMemberPeerStats);
            }
            await this.render();
            this.videoEl.srcObject = view.stream;
            this.$el.toggleClass('streaming', view.isStreaming());
            this.$el.toggleClass('audio-only', view.isAudioOnly());
            this.$el.toggleClass('silenced', view.isSilenced());
            this.$el.toggleClass('pinned', view.isPinned());
        },

        onSilenceClick: function() {
            this.memberView.toggleSilenced();
        },

        onFullscreenVideoClick: function() {
            this.toggleFullscreen();
        },

        onPopoutClick: function() {
            this.togglePopout();
        },

        toggleFullscreen: async function() {
            const currentFullscreen = F.util.fullscreenElement();
            if (currentFullscreen) {
                await F.util.exitFullscreen();
                if (currentFullscreen === this.videoEl) {
                    return;
                }
            }
            await F.util.requestFullscreen(this.videoEl);
        },

        togglePopout: async function() {
            if (this.callView.isFullscreen()) {
                await F.util.exitFullscreen();
            }
            if (document.pictureInPictureElement) {
                if (document.pictureInPictureElement === this.videoEl) {
                    await document.exitPictureInPicture();
                    return;
                }
            }
            await this.videoEl.requestPictureInPicture();
        },

        throttledVolumeIndicate: _.throttle(function() {
            if (!this.$soundIndicators || !this.$soundIndicators.length) {
                return;
            }
            const loudness = Math.min(1, Math.max(0, volumeLoudness(this.memberView.soundDBV)));
            this.$soundIndicators.css('width', Math.round(loudness * 100) + '%');
        }, 1000 / 25),

        onMemberStreamUpdate: function(view, stream) {
            if (this.videoEl) {
                this.videoEl.srcObject = stream;
            }
        },

        onMemberStreaming: function(view, streaming) {
            this.$el.toggleClass('streaming', streaming);
        },

        onMemberAudioOnly: function(view, audioOnly) {
            this.$el.toggleClass('audio-only', audioOnly);
        },

        onMemberPinned: function(view, pinned) {
            this.$el.toggleClass('pinned', pinned);
        },

        onMemberSilenced: function(view, silenced) {
            this.$el.toggleClass('silenced', silenced);
        },

        onMemberStatusChanged: function(view, value) {
            this.$('.f-status').text(value);
        },

        onMemberSoundLevel: function(levels) {
            this.throttledVolumeIndicate.call(this);
        },

        onMemberPeerStats: function(peer, stats) {
            if (!this.callView.$el.hasClass('debug-stats')) {
                return;
            }
            const $debugStats = this.$('.f-debug-stats');
            const now = Date.now();
            const trackIds = new Set(stats.map(x => x.track.id));
            for (const el of $debugStats.find('.track')) {
                if (!trackIds.has(el.dataset.id)) {
                    $(el).remove();
                }
            }
            for (const stat of stats) {
                let $track = $debugStats.find(`.track[data-id="${stat.track.id}"]`);
                if (!$track.length) {
                    $track = $(`
                        <div class="track" data-id="${stat.track.id}"
                                           data-created="${now}">
                            <b>${stat.track.kind} track:</b> ${stat.track.id.split('-')[0]}</b>
                            <div class="stats"></div>
                        </div>
                    `);
                    $track.data('bitsHistory', []);
                    this.$(`.f-debug-stats .column.${stat.direction}`).append($track);
                }
                const $stats = $track.children('.stats');
                const status = [stat.track.enabled ? '<green>ENABLED</green>' : '<red>DISABLED</red>'];
                if (stat.track.muted) {
                    status.push('<red>MUTED</red>');
                }
                const rows = [`<b>Status:</b> ${status.join(', ')}`];
                for (const x of stat.data.values()) {
                    if (x.type === 'codec') {
                        rows.push(`<b>Codec:</b> ${x.mimeType.split('/')[1]}`);
                    } else if (x.type === 'inbound-rtp' || x.type === 'outbound-rtp') {
                        let bits;
                        if (x.type === 'inbound-rtp') {
                            bits = x.bytesReceived * 8;
                            rows.push(`<b>Bytes recv:</b> ${x.bytesReceived}`);
                            rows.push(`<b>Packets lost:</b> ${x.packetsLost}`);
                        } else {
                            bits = x.bytesSent * 8;
                            rows.push(`<b>Bytes sent:</b> ${x.bytesSent}`);
                            if (x.retransmittedPacketsSent != null) {
                                rows.push(`<b>Retransmitted packets:</b> ${x.retransmittedPacketsSent}`);
                            }
                        }
                        const bitsHistory = $track.data('bitsHistory');
                        bitsHistory.unshift({ts: now, bits});
                        bitsHistory.length = Math.min(bitsHistory.length, 10);
                        if (bitsHistory.length > 2) {
                            const first = bitsHistory[0];
                            const last = bitsHistory[bitsHistory.length - 1];
                            const elapsed = (last.ts - first.ts) / 1000;
                            const transmitted = last.bits - first.bits;
                            const bitrate = F.tpl.help.humanbits(transmitted / elapsed);
                            rows.push(`<b>Bitrate:</b> ${bitrate}ps`);
                        }

                    } else if (x.type === 'track') {
                        if (x.kind === 'audio') {
                            if (x.audioLevel != null) {
                                rows.push(`<b>Audio level:</b> ${x.audioLevel.toFixed(6)}`);
                            }
                        } else {
                            const width = x.frameWidth;
                            const height = x.frameHeight;
                            if (width && height) {
                                rows.push(`<b>Resolution:</b> ${width}x${height}`);
                            }
                            if (x.framesDecoded != null) {
                                const dropped = (x.framesDropped != null) ? ` (${x.framesDropped} dropped)` : '';
                                rows.push(`<b>Frames:</b> ${x.framesDecoded}${dropped}`);
                            }
                        }
                    }
                }
                $stats.html(rows.join('<br/>'));
            }
        }
    });


    F.CallSettingsView = F.ModalView.extend({
        contentTemplate: 'views/call-settings.html',
        extraClass: 'f-call-settings-view',
        size: 'small',
        header: 'Call Settings',
        icon: 'settings',
        scrolling: false,
        allowMultiple: true,

        legacyAutoBPS: 10 * 1024 * 1024,
        bpsMax: (10 * 1024 * 1024) - 1,  // Keep lower than legacy unlimited

        events: {
            'input .f-bitrate-limit input': 'onBpsInput',
            'change .f-bitrate-limit input': 'onBpsChange',
        },

        initialize: function(options) {
            F.assert(options.callView);
            this.callView = options.callView;
            this._changed = new Set();
            F.ModalView.prototype.initialize.apply(this, arguments);
        },

        render_attributes: async function() {
            const settings = await F.state.getDict([
                'callIngressBps',
                'callEgressBps',
                'callVideoResolution',
                'callVideoFacing',
            ]);
            const devices = await navigator.mediaDevices.enumerateDevices();
            return Object.assign({
                bpsMax: this.bpsMax,
                ingressPct: this.bpsToPercent(settings.callIngressBps),
                egressPct: this.bpsToPercent(settings.callEgressBps),
                videoDevices: devices.filter(x => x.kind === 'videoinput'),
                audioInputDevices: devices.filter(x => x.kind === 'audioinput'),
                audioOutputDevices: devices.filter(x => x.kind === 'audiooutput'),
                canAssignAudioOutput,
            }, await F.ModalView.prototype.render_attributes.apply(this, arguments));
        },

        render: async function() {
            await F.ModalView.prototype.render.apply(this, arguments);
            // Update labels...
            for (const el of this.$('.f-bitrate-limit input')) {
                this.onBpsInput(null, $(el));
            }
            const videoRes = await F.state.get('callVideoResolution', 'auto');
            this.$('.f-video-res .ui.dropdown').dropdown('set selected', videoRes).dropdown({
                onChange: this.onVideoResChange.bind(this),
            });
            const videoFps = await F.state.get('callVideoFps', 'auto');
            this.$('.f-video-fps .ui.dropdown').dropdown('set selected', videoFps).dropdown({
                onChange: this.onVideoFpsChange.bind(this),
            });
            const videoDevice = await F.state.get('callVideoDevice', 'auto');
            this.$('.f-video-device .ui.dropdown').dropdown('set selected', videoDevice).dropdown({
                onChange: this.onVideoDeviceChange.bind(this),
            });
            const audioInputDevice = await F.state.get('callAudioInputDevice', 'auto');
            this.$('.f-audio-input-device .ui.dropdown').dropdown('set selected', audioInputDevice).dropdown({
                onChange: this.onAudioInputDeviceChange.bind(this),
            });
            const audioOutputDevice = await F.state.get('callAudioOutputDevice', 'auto');
            this.$('.f-audio-output-device .ui.dropdown').dropdown('set selected', audioOutputDevice).dropdown({
                onChange: this.onAudioOutputDeviceChange.bind(this),
            });
            const debugStats = !!await F.state.get('callDebugStats');
            const $cb = this.$('.f-debug .ui.checkbox');
            if (debugStats) {
                $cb.checkbox('set checked');
            }
            $cb.checkbox({
                onChange: this.onDebugStatsChange.bind(this),
            });
            return this;
        },

        setChanged: function(changed) {
            if (!this._changed.size) {
                this.$('footer .approve.button').html('Apply Changes').addClass('green').transition('pulse');
                this._changed.add(changed);
            }
        },

        bpsToPercent: function(bps) {
            if (!bps || bps === this.legacyAutoBPS) {
                return 0;
            }
            bps = Math.min(this.bpsMax, Math.max(0, bps));
            return bps  / this.bpsMax;
        },

        percentToBps: function(pct) {
            pct = Math.min(1, Math.max(0, pct));
            return pct * this.bpsMax;
        },

        onBpsInput: function(ev, $input) {
            $input = $input || $(ev.currentTarget);
            const value = this.percentToBps(Number($input.val()));
            let label;
            if (!value) {
                label = 'Auto';
            } else {
                label = F.tpl.help.humanbits(value) + 'ps';
            }
            $input.siblings('.ui.label').text(label);
        },

        onBpsChange: async function(ev) {
            const inputEl = ev.currentTarget;
            const value = this.percentToBps(Number(inputEl.value));
            const stateKey = inputEl.dataset.direction === 'ingress' ? 'callIngressBps' : 'callEgressBps';
            // Legacy bps values of bpsMax represented auto mode.  This would lead to regressions so now
            // we use 0 as auto mode but must detect legacy formats..
            await F.state.put(stateKey, (value === this.legacyAutoBPS || !value) ? undefined : value);
            this.setChanged('bps');
        },

        onVideoResChange: async function(value) {
            await F.state.put('callVideoResolution', value === 'auto' ? value : Number(value));
            this.setChanged('constraint');
        },

        onVideoFpsChange: async function(value) {
            await F.state.put('callVideoFps', value === 'auto' ? value : Number(value));
            this.setChanged('constraint');
        },

        onVideoDeviceChange: async function(value) {
            await F.state.put('callVideoDevice', value);
            this.setChanged('stream');
        },

        onAudioInputDeviceChange: async function(value) {
            await F.state.put('callAudioInputDevice', value);
            this.setChanged('stream');
        },

        onAudioOutputDeviceChange: async function(value) {
            await F.state.put('callAudioOutputDevice', value);
            this.setChanged('audio-sink');
        },

        onDebugStatsChange: async function() {
            const value = this.$('.f-debug .ui.checkbox input')[0].checked;
            await F.state.put('callDebugStats', value);
            this.setChanged('debug-stats');
        },

        onForceH264Change: async function() {
            const value = this.$('.f-force-h264 .ui.checkbox input')[0].checked;
            await F.state.put('callForceH264', value);
            this.setChanged('stream');
        },

        onHidden: async function() {
            if (this._changed.size) {
                if (this._changed.has('stream')) {
                    await this.callView.bindOutStream();
                    this._changed.delete('stream');
                    this._changed.delete('constraint');
                } else if (this._changed.has('constraint')) {
                    await this.callView.applyStreamConstraints();
                    this._changed.delete('constraint');
                }
                if (this._changed.has('audio-sink')) {
                    this._changed.delete('audio-sink');
                    for (const view of this.callView.getMemberViews()) {
                        if (!view.outgoing) {
                            await view.render();
                        }
                    }
                }
                if (this._changed.has('debug-stats')) {
                    this._changed.delete('debug-stats');
                    this.callView.$el.toggleClass('debug-stats', !!await F.state.get('callDebugStats'));
                }
                if (this._changed.size && this.callView.isJoined()) {
                    logger.warn("Restarting connection to apply changes.");
                    const type = this.callView.joinType;
                    await this.callView.leave();
                    await this.callView.join({type});
                }
            }
            await F.ModalView.prototype.onHidden.apply(this, arguments);
        },
    });


    class SoundMeter {
        // Adapted from: https://github.com/webrtc/samples/blob/gh-pages/src/content/getusermedia/volume/js/soundmeter.js

        constructor(stream, onLevel) {
            this.rms = 0;
            this.averageRms = 0;
            this.dBV = -100;
            this.averageDBV = -100;
            const ctx = getAudioContext();
            if (!ctx) {
                return;
            }
            this.script = ctx.createScriptProcessor(2048, 1, 1);
            this.script.addEventListener('audioprocess', event => {
                let sum = 0;
                for (const x of event.inputBuffer.getChannelData(0)) {
                    sum += x * x;
                }
                this.rms = Math.sqrt(sum / event.inputBuffer.length);
                this.dBV = 20 * Math.log10(this.rms);
                this.averageRms = 0.90 * this.averageRms + 0.10 * this.rms;
                this.averageDBV = 20 * Math.log10(this.averageRms);
                onLevel({
                    rms: this.rms,
                    averageRms: this.averageRms,
                    dBV: this.dBV,
                    averageDBV: this.averageDBV
                });
            });
            this.source = ctx.createMediaStreamSource(stream);
            this.source.connect(this.script);
            this.script.connect(ctx.destination);  // Required for chromium, must have destination wired.
        }

        disconnect() {
            if (this.source) {
                this.source.disconnect();
                this.source = null;
            }
            if (this.script) {
                this.script.disconnect();
                this.script = null;
            }
        }
    }
})();
