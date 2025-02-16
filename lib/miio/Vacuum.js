const dgram = require("dgram");
const prettyCron = require("prettycron");

const HandshakePacket = require("./HandshakePacket");
const Codec = require("./Codec");
const Stamp = require("./Stamp");
const Tools = require("../Tools");


/**
 * @param options {object}
 * @param options.ip {string}
 * @param options.tokenProvider {function}
 * @param options.events {EventEmitter}
 * @param options.model {string}
 * @constructor
 */
const Vacuum = function(options) {
    const self = this;

    // roborock.vacuum.s5 or rockrobo.vacuum.v1
    this.model = options.model;
    this.tokenProvider = options.tokenProvider;
    this.events = options.events;

    this.ip = options.ip;
    this.token = this.tokenProvider();
    if(this.token.length !== 16) {
        throw new Error("Invalid token");
    }

    this.socket = dgram.createSocket("udp4");
    this.codec = new Codec({token: this.token});
    this.stamp = new Stamp({});
    this.deviceId = 0;
    this.lastId = this.initialId = 1000;
    this.lastIdProbed = false;
    this.pendingRequests = {};

    this.socket.bind();
    this.socket.on("listening", function(){});

    this.handshakeInProgress = false;
    this.handshakeTimeout = null;

    this.socket.on("message", function(msg, rinfo){
        const decodedResponse = self.codec.handleResponse(msg);
        self.stamp = new Stamp({val: decodedResponse.stamp});
        if (self.handshakeInProgress && decodedResponse.stamp) {
            clearTimeout(self.handshakeTimeout);
            self.handshakeInProgress = false;
        }
        self.deviceId = decodedResponse.deviceId;

        if(decodedResponse.msg) {
            if(self.pendingRequests[decodedResponse.msg.id]) {
                if (!self.lastIdProbed) {
                    self.lastIdProbed = true;
                    console.log("Probed last id = " + self.lastId + ' using ' + self.pendingRequests[decodedResponse.msg.id].method + " (" + self.pendingRequests[decodedResponse.msg.id].retries + " retries)");
                }
                self.pendingRequests[decodedResponse.msg.id].callback(decodedResponse.msg.result);
                delete(self.pendingRequests[decodedResponse.msg.id]);
            }
        } else if (decodedResponse.token && decodedResponse.token.toString("hex") !== "ffffffffffffffffffffffffffffffff") {
            console.info("Got token from handshake:", decodedResponse.token.toString("hex"));
            self.token = decodedResponse.token;
            self.codec.setToken(self.token);
        }
    });
};

Vacuum.prototype.handshake = function() {
    if (this.handshakeInProgress) {
        return;
    }
    const self = this;
    this.handshakeInProgress = true;
    this.handshakeTimeout = setTimeout(() => { self.handshakeInProgress = false; },100);
    const packet = new HandshakePacket();
    this.socket.send(packet.header, 0, packet.header.length, Vacuum.PORT, this.ip);
};

Vacuum.prototype.sendMessage = function(method, args, options, callback) {
    options.retries = options.retries || 0;
    options.retriesHS = options.retriesHS || 0;

    if (options.retriesHS++ > 100 && this.lastId > this.initialId) {
        // since the service automatically restarts, just let it do it
        // but only if there were successful communications before (hello ./develop/run)
        console.error('failed to get handshake for message:', method, args, options);
        throw new Error("Unable to reach vacuum, handshake failed is the token right?");
    }

    if(!this.stamp.isValid()) {
        this.handshake();
        setTimeout(function tryAgainAfterHandshake(){
            this.sendMessage(method, args, options, callback);
        }.bind(this), 150);
        return;
    }

    if (options.retries++ > 400) {
        // same for missing message responses
        console.error('failed to get response for message:', method, args, options);
        throw new Error("Unable to reach vacuum, no response for message");
    }

    let timeout;
    let resultHandler;
    let id;

    if (options.retries % 20 === 0 && options.retries >= 20) {
        // we may want to refresh the token from fs just to be sure
        let newToken = this.tokenProvider();
        if (!(this.token.equals(newToken))) {
            console.info("Got an expired token. Changing to new");
            this.token = newToken;
            this.codec.setToken(this.token);
        }
        // also reset a stamp just in case
        this.stamp = new Stamp({});
    }

    // this probably will never happen but still
    if (this.lastId > 1000000) {
        this.lastId = this.initialId;
    }

    if (!this.lastIdProbed && options.retries > 1) {
        this.lastId += 1000;
    } else {
        this.lastId++;
    }

    id = this.lastId;

    const request = {
        id: id,
        method: method,
        params: args
    };

    timeout = setTimeout(function() {
        delete(this.pendingRequests[id]);
        this.sendMessage(method, args, options, callback);
    }.bind(this), 150);

    resultHandler = function(msg) {
        clearTimeout(timeout);
        callback(null, msg);
    };

    this.pendingRequests[id] = {
        callback: resultHandler,
        method: method,
        retries: options.retries + options.retriesHS
    }

    const msg = this.codec.encode(Buffer.from(JSON.stringify(request), "utf8"), this.stamp, this.deviceId);
    this.socket.send(msg, 0, msg.length, Vacuum.PORT, this.ip);
};

/**
 * Starts cleaning
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.startCleaning = function(callback) {
    this.sendMessage("app_start", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Stops cleaning
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.stopCleaning = function(callback) {
    this.sendMessage("app_stop", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Pause cleaning
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.pauseCleaning = function(callback) {
    this.sendMessage("app_pause", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Resumes zone cleaning after being paused
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.resumeCleaningZone = function(callback) {
    this.sendMessage("resume_zoned_clean", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Go back to the dock
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.driveHome = function(callback) {
    this.sendMessage("app_charge", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.spotClean = function(callback) {
    this.sendMessage("app_spot", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.startManualControl = function(callback) {
    this.sendMessage("app_rc_start", [], {}, callback)
};

Vacuum.prototype.stopManualControl = function(callback) {
    this.sendMessage("app_rc_end", [], {}, callback)
};

Vacuum.prototype.setManualControl = function(angle, velocity, duration, sequenceId, callback) {
    this.sendMessage("app_rc_move", [{"omega": angle, "velocity": velocity, "seqnum": sequenceId, "duration": duration}], {}, callback)
};

/**
 * Returns carpet detection parameter like
 * {
 *      'enable': 1,
 *      'current_integral': 450,
 *      'current_low': 400,
 *      'current_high': 500,
 *      'stall_time': 10
 * }
 */
Vacuum.prototype.getCarpetMode = function(callback) {
    this.sendMessage("get_carpet_mode", [], {}, function(err, response){
        if(err) {
            callback(err);
        } else {
            callback(null, response);
        }
    })
};

Vacuum.prototype.setCarpetMode = function(enable, current_integral, current_low, current_high, stall_time , callback) {
    this.sendMessage(
        "set_carpet_mode",
        [{
            "enable": (enable === true ? 1 : 0),
            "stall_time": parseInt(stall_time),
            "current_low": parseInt(current_low),
            "current_high": parseInt(current_high),
            "current_integral": parseInt(current_integral)
        }],
        {},
        callback
    );
};

/**
 * Play sound to locate robot
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param of callback looks like this: 'ok'
 * @param callback
 */
Vacuum.prototype.findRobot = function(callback) {
    this.sendMessage("find_me", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Get a list of all timers
 * Returns an error if there is one as the first parameter of the callback
 * On success, returns an array of timers as plain objects:
 * {
 *     id: "1530115775048",
 *     cron: "* 2 * * *",
 *     enabled: true
 * }
 * @param callback
 */
Vacuum.prototype.getTimers = function(callback) {
    this.sendMessage("get_timer", [], {}, function(err, response){
        if(err) {
            callback(err);
        } else {
            const timers = [];
            let err;

            response.forEach(function(elem){
                if(!Array.isArray(elem) || (Array.isArray(elem) && elem.length < 3)){
                    err = new Error("Invalid response");
                } else {
                    timers.push({
                        id: elem[0],
                        cron: elem[2][0],
                        enabled: elem[1] === "on",
                        human_desc: prettyCron.toString(elem[2][0])
                    })
                }
            });

            if(err) {
                callback(err);
            } else {
                callback(null, timers);
            }
        }
    })
};

/**
 * Set a new timer
 * Returns an error if there is one as the first parameter of the callback
 * @param cron {string}
 * @param callback
 */
Vacuum.prototype.addTimer = function(cron, callback) {
    this.sendMessage("set_timer", [[Date.now().toString(),[cron, ["",""]]]], {}, callback);
};

/**
 * Deletes the timer with the given id
 * Returns an error if there is one as the first parameter of the callback
 * @param id {string}
 * @param callback
 */
Vacuum.prototype.deleteTimer = function(id, callback) {
    this.sendMessage("del_timer", [id], {}, callback);
};

/**
 * Sets the timer with the given id to the given state
 * Returns an error if there is one as the first parameter of the callback
 * @param id {string}
 * @param enabled {boolean}
 * @param callback
 */

Vacuum.prototype.toggleTimer = function(id, enabled, callback) {
    this.sendMessage("upd_timer", [id, enabled === true ? "on" : "off"], {}, callback);
};

/**
 * Returns json dnd timer in the following format
 * {
 *      'enabled': 1,
 *      'start_minute': 0,
 *      'end_minute': 0,
 *      'start_hour': 22,
 *      'end_hour': 8
 * }
 * @param callback
 */
Vacuum.prototype.getDndTimer = function(callback) {
    this.sendMessage("get_dnd_timer", [], {}, function(err, response){
        if(err) {
            callback(err);
        } else {
            callback(null, response);
        }
    })
};

/**
 * Set dnd timer
 * @param start_hour
 * @param start_minute
 * @param end_hour
 * @param end_minute
 * @param callback
 */
Vacuum.prototype.setDndTimer = function(start_hour, start_minute, end_hour, end_minute, callback) {
    this.sendMessage("set_dnd_timer", [parseInt(start_hour), parseInt(start_minute), parseInt(end_hour), parseInt(end_minute)], {}, callback);
};

/**
 * Disable dnd
 * @param callback
 */
Vacuum.prototype.deleteDndTimer = function(callback) {
    this.sendMessage("close_dnd_timer", [""], {}, callback);
};

/**
 * Get Timezone
 */
Vacuum.prototype.getTimezone = function(callback) {
    this.sendMessage("get_timezone", [], {}, function(err, response){
        if(err) {
            callback(err);
        } else {
            callback(null, response);
        }
    })
};

/**
 * Set Timezone
 * @param new_zone new timezone
 * @param callback {function}
 */
Vacuum.prototype.setTimezone = function(new_zone, callback) {
    this.sendMessage("set_timezone", [new_zone], {}, callback);
};

/*
    0-100: percent

    Or presets:
    101: quiet
    102: balanced
    103: Turbo
    104: Max
    105: Mop
 */
Vacuum.prototype.setFanSpeed = function(speed, callback) {
    this.sendMessage("set_custom_mode", [parseInt(speed)], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.setSoundVolume = function(volume, callback) {
    this.sendMessage("change_sound_volume", [parseInt(volume)], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.getSoundVolume = function(callback) {
    this.sendMessage("get_sound_volume", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.testSoundVolume = function(callback) {
    this.sendMessage("test_sound_volume", [], {}, callback)
};

Vacuum.prototype.resetConsumable = function(consumable, callback) {
    this.sendMessage("reset_consumable", [consumable], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

Vacuum.prototype.configureWifi = function(ssid, password, callback) {
    this.sendMessage("miIO.config_router", {"ssid": ssid, "passwd": password, "uid": 0}, {}, callback)
};

/**
 * Starts the installation of a new voice pack
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param looks like this:
 *  {
 *      "progress": 0,
 *      "state": 0,
 *      "error": 0
 *  }
 *
 *
 * @param url {string}
 * @param md5 {string}
 * @param callback
 */
Vacuum.prototype.installVoicePack = function(url, md5, callback) {
    this.sendMessage("dnld_install_sound", {"url": url, "md5": md5, "sid": 10000}, {}, callback);
};

/**
 * Returns the current voice pack installation status
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param looks like this:
 *  {
 *      "sid_in_progress": 10000,
 *      "progress": 100,
 *      "state": 2,
 *      "error": 0
 *  }
 *
 *
 * @param callback
 */
Vacuum.prototype.getVoicePackInstallationStatus = function(callback) {
    this.sendMessage("get_sound_progress", [], {}, callback);
};

/**
 * Returns the current status of the robot
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param looks like this:
 *  {
 *      msg_ver: 2,
 *      msg_seq: 11,
 *      state: 8,
 *      battery: 100,
 *      clean_time: 0,
 *      clean_area: 0,
 *      error_code: 0,
 *      map_present: 0,
 *      in_cleaning: 0,
 *      fan_power: 60,
 *      dnd_enabled: 0
 *  }
 *
 *
 * @param callback
 */
Vacuum.prototype.getCurrentStatus = function(callback) {
    const self = this;

    this.sendMessage("get_status", [], {}, Vacuum.GET_ARRAY_HANDLER(function(err, res){
        if(err) {
            callback(err);
        } else {
            res.human_state = Vacuum.GET_STATE_CODE_DESCRIPTION(res.state);
            res.human_error = Vacuum.GET_ERROR_CODE_DESCRIPTION(res.error_code);
            delete(res["msg_seq"]);

            callback(null, res);
        }
    }));
};

/**
 * Returns the current status of the robots consumables
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param looks like this:
 *  {
 *      main_brush_work_time: 77974,
 *      side_brush_work_time: 77974,
 *      filter_work_time: 77974,
 *      sensor_dirty_time: 77808
 *  }
 *
 *
 * @param callback
 */
Vacuum.prototype.getConsumableStatus = function(callback) {
    this.sendMessage("get_consumable", [], {}, Vacuum.GET_ARRAY_HANDLER(callback));
};

/**
 * Returns the cleaning history
 * Returns an error if there is one as the first parameter of the callback
 * On success, 2nd param looks like this:
 * [81234,1199407500,76,[1530283329,1530130601,...]]
 *
 * total time in seconds
 * total area in mm²
 * total clean count
 * [ array containing up to 20 runs from the past .. ]
 *
 * @param callback
 */
Vacuum.prototype.getCleanSummary = function(callback) {
    this.sendMessage("get_clean_summary", [], {}, callback);
};

/**
 * Returns record of a specific cleaning run.
 * This requires a unique recordId that is provided in the (optional) list attached to getCleanSummary.
 * Result may look like:
 * {
 *  1550328301, //timestamp run was started
 *  1550329141, //timestamp run was finished
 *  840,        //duration in seconds
 *  14497500,   //=> 14.4975 m^2
 *  0,          //ErrorCode (references to Vacuum.ERROR_CODES)
 *  1           //CompletedFlag (0: did not complete, 1: did complete)
 * }
 * @param recordId id of the record the details should be fetched for
 * @param callback
 */
Vacuum.prototype.getCleanRecord = function (recordId, callback) {
    this.sendMessage("get_clean_record", [parseInt(recordId)], {}, callback);
};

/**
 * Requests cleaning run map snapshot upload
 * This requires a unique recordId that is provided in the (optional) list attached to getCleanSummary.
 *
 * @param recordId id of the record the details should be fetched for
 * @param callback
 */
Vacuum.prototype.getCleanRecordMap = function (recordId, callback) {
    this.sendMessage("get_clean_record_map", [parseInt(recordId)], {}, callback);
};

/**
 * Sets the lab status aka persistent data feature of the S50
 * @param {boolean} flag true for enabling lab mode and false for disabling
 * @param {(err: Error, res: any) => {}} callback
 */
Vacuum.prototype.setLabStatus = function(flag, callback) {
    const labStatus = flag ? 1 : 0;
    this.sendMessage("set_lab_status", [labStatus], {}, callback);
};

/**
 * Resets all persistent data (map, forbidden zones and virtual walls)
 * @param {(err: Error, res: any) => {}} callback
 */
Vacuum.prototype.resetMap = function(callback) {
    this.sendMessage("reset_map", [], {}, callback);
};

/* Some words on coordinates for goTo and startCleaningZone:
   Coordinates are in mm and need to be in raw and unflipped format.
   */
Vacuum.prototype.goTo = function(x_coord, y_coord, callback) {
    this.sendMessage("app_goto_target", [x_coord, 51200 - y_coord], {}, callback)
};

/* zones is an array of areas to clean:  [[x1, y1, x2, y2, iterations],..] */
Vacuum.prototype.startCleaningZone = function(zones, callback) {
    if(Array.isArray(zones) && zones.length <= 5 && zones.length > 0) {
        const flippedZones = zones.map(zone => {
            const yFlippedZone = [
                zone[0],
                Tools.DIMENSION_MM - zone[1],
                zone[2],
                Tools.DIMENSION_MM - zone[3],
                zone[4]
            ];

            // it seems as the vacuum only works with 'positive rectangles'! So flip the coordinates if the user entered them wrong.
            // x1 has to be < x2 and y1 < y2
            return [
                yFlippedZone[0] > yFlippedZone[2] ? yFlippedZone[2] : yFlippedZone[0],
                yFlippedZone[1] > yFlippedZone[3] ? yFlippedZone[3] : yFlippedZone[1],
                yFlippedZone[0] > yFlippedZone[2] ? yFlippedZone[0] : yFlippedZone[2],
                yFlippedZone[1] > yFlippedZone[3] ? yFlippedZone[1] : yFlippedZone[3],
                yFlippedZone[4]
            ]
        });

        this.sendMessage("app_zoned_clean", flippedZones, {}, callback)
    } else {
        callback(new Error("Zones must be array of at most 5 zones."))
    }
};

/**
 * Saves the persistent data like virtual walls and forbidden zones
 * @param persistentData is an array of walls / zones
 * They have to be provided in the following format:
 *      https://github.com/marcelrv/XiaomiRobotVacuumProtocol/issues/15#issuecomment-447647905
 *      Software barrier takes a vector of [id, x1,y1,x2,y2]
 *      And no-go zone takes [id, x1,y1,x2,y2,x3,y3,x4,y4], which are the corners of the zone rectangle?
 *      Edit: see @JensBuchta's comment. The first parameter appears to be a type: 0 = zone, 1 = barrier
 * @param persistantData
 * @param callback
 */
Vacuum.prototype.savePersistentData = function(persistantData, callback) {
    if(Array.isArray(persistantData)) {
        const flippedYCoordinates = persistantData.map(data => {
            if(data[0] === 0) {
                // this is a zone
                return [
                    data[0],
                    data[1],
                    Tools.DIMENSION_MM - data[2],
                    data[3],
                    Tools.DIMENSION_MM - data[4],
                    data[5],
                    Tools.DIMENSION_MM - data[6],
                    data[7],
                    Tools.DIMENSION_MM - data[8]
                ];
            } else {
                // this is a barrier
                return [
                    data[0],
                    data[1],
                    Tools.DIMENSION_MM - data[2],
                    data[3],
                    Tools.DIMENSION_MM - data[4],
                ];
            }
        });

        if (flippedYCoordinates.reduce((total,current) => { return total += current[0] === 0 ? 4 : 2; }, 0) > 68) {
            callback(new Error("too many forbidden markers to save!"));
            return;
        }

        this.sendMessage("save_map", flippedYCoordinates, {}, (err) => {
            this.events.emit("valetudo.dummycloud.pollmap");
            callback(err);
        });
    }
    else callback(new Error("persistantData has to be an array."));
};

/**
 * This method provides some app details like:
 * {
 *  'location': 'de',
 *  'wifiplan': '',
 *  'logserver': 'awsde0.fds.api.xiaomi.com',
 *  'name': 'custom_A.03.0005_CE',
 *  'timezone': 'Europe/Berlin',
 *  'bom': 'A.03.0005',
 *  'language': 'en'
 * }
 */
Vacuum.prototype.getAppLocale = function(callback) {
    this.sendMessage("app_get_locale", [], {}, function(err, response){
        if(err) {
            callback(err);
        } else {
            callback(null, response);
        }
    })
};

Vacuum.PORT = 54321;

Vacuum.GET_ARRAY_HANDLER = function(callback) {
    return function(err, res) {
        if(err) {
            callback(err);
        } else {
            callback(null, res[0])
        }
    }
};

Vacuum.GET_ERROR_CODE_DESCRIPTION = function(errorCodeId) {
    if (Vacuum.ERROR_CODES.hasOwnProperty(errorCodeId)) {
        return Vacuum.ERROR_CODES[errorCodeId];
    } else {
        return "UNKNOWN ERROR CODE";
    }
};

Vacuum.GET_STATE_CODE_DESCRIPTION = function(stateCodeId) {
    if (Vacuum.STATES.hasOwnProperty(stateCodeId)) {
        return Vacuum.STATES[stateCodeId];
    } else {
        return "UNKNOWN STATE CODE";
    }
};

Vacuum.STATES = {
    1: "Starting",
    2: "Standby without Charging",
    3: "Idle",
    4: "Remote control active",
    5: "Cleaning",
    6: "Returning to dock",
    7: "Manual mode",
    8: "Charging",
    9: "Charging problem",
    10: "Paused",
    11: "Spot cleaning",
    12: "Error",
    13: "Shutting down",
    14: "Updating",
    15: "Docking",
    16: "Going to target",
    17: "Zoned cleaning"
};

Vacuum.ERROR_CODES = {
    0: "No error",
    1: "Laser distance sensor error",
    2: "Front bumper jammed",
    3: "Cliff sensors alarm, carry the robot to different place",
    4: "Cliff sensors dirty",
    5: "Main brush stuck",
    6: "Side brush stuck",
    7: "Main wheels stuck",
    8: "Device stuck, carry the robot to different place",
    9: "Dust collector missing or bad filter",
    10: "Dust filter dirty",
    11: "Stuck in magnetic barrier",
    12: "Low battery",
    13: "Charging fault",
    14: "Battery fault",
    15: "Wall sensor dirty",
    16: "Surface is not flat, carry the robot to different place",
    17: "Side brush fault, try rebooting",
    18: "Suction fan fault, try rebooting",
    19: "Unpowered charging station",
    21: "Top cover of laser distance sensor pinned",
    22: "Front bumper sensor dirty",
    23: "Signal emission area on the dock dirty",
    24: "Forbidden area detected, evacuate the robot to allowed place"
};

module.exports = Vacuum;
