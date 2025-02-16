const Tools = {
    DIMENSION_PIXELS: 1024,
    DIMENSION_MM: 50 * 1024
};

function RRDataView(arrayBuffer) {
    this._dataView = new DataView(arrayBuffer, 0);
};
RRDataView.prototype.readUInt8 = function(offset) {
    return this._dataView.getUint8(offset);
}
RRDataView.prototype.readUInt16LE = function(offset) {
    return this._dataView.getUint16(offset, true);
}
RRDataView.prototype.readUInt32LE = function(offset) {
    return this._dataView.getUint32(offset, true);
}
RRDataView.prototype.readInt32LE = function(offset) {
    return this._dataView.getInt32(offset, true);
}
Object.defineProperty(RRDataView.prototype, "length", {
    get: function getLength() {
        return this._dataView.byteLength;
    }
});

export function RRMapParser() {};

RRMapParser.TYPES = {
    "CHARGER_LOCATION": 1,
    "IMAGE": 2,
    "PATH": 3,
    "GOTO_PATH": 4,
    "GOTO_PREDICTED_PATH": 5,
    "CURRENTLY_CLEANED_ZONES": 6,
    "GOTO_TARGET": 7,
    "ROBOT_POSITION": 8,
    "FORBIDDEN_ZONES": 9,
    "VIRTUAL_WALLS": 10,
    "DIGEST": 1024
};

RRMapParser.PARSE_BLOCK = function parseBlock(buf, offset, result) {
    result = result || {};
    if (buf.length <= offset) {
        return result;
    }
    let type_based_offset = 0x0;

    var type = buf.readUInt16LE(0x00 + offset);
    var length = buf.readUInt32LE(0x04 + offset);

    //TODO: Check if more values are in fact signed
    switch (type) {
        case RRMapParser.TYPES.ROBOT_POSITION:
        case RRMapParser.TYPES.CHARGER_LOCATION:
            result[type] = {
                position: [
                    buf.readUInt16LE(0x08 + offset),
                    buf.readUInt16LE(0x0c + offset)
                ]
            };
            break;
        case RRMapParser.TYPES.IMAGE:
            const parameters = {
                position: {
                    top: buf.readInt32LE(0x08 + offset),
                    left: buf.readInt32LE(0x0c + offset)
                },
                dimensions: {
                    height: buf.readInt32LE(0x10 + offset),
                    width: buf.readInt32LE(0x14 + offset)
                },
                pixels: []
            };

            // position.left has to be position right for supporting the flipped map
            parameters.position.top = Tools.DIMENSION_PIXELS - parameters.position.top - parameters.dimensions.height;

            //There can only be pixels if there is an image
            if(parameters.dimensions.height > 0 && parameters.dimensions.width > 0) {
                parameters.pixels = {
                    floor: [],
                    obstacle_weak: [],
                    obstacle_strong: []
                };

                for (let i = 0; i < length; i++) {
                    switch(buf.readUInt8(0x18 + offset + i)) {
                        case 1:
                            parameters.pixels.obstacle_strong.push(i);
                            break;
                        case 8:
                            parameters.pixels.obstacle_weak.push(i);
                            break;
                        case 255:
                            parameters.pixels.floor.push(i);
                            break;
                    }
                }
            }

            result[type] = parameters;

            type_based_offset = 0x10;
            break;
        case RRMapParser.TYPES.PATH:
        case RRMapParser.TYPES.GOTO_PATH:
        case RRMapParser.TYPES.GOTO_PREDICTED_PATH:
            const points = [];
            for (let i = 0; i < length; i = i + 4) {
                //to draw these coordinates onto the map pixels, they have to be divided by 50
                points.push(
                    buf.readUInt16LE(0x14 + offset + i),
                    buf.readUInt16LE(0x14 + offset + i + 2)
                );
            }

            result[type] = {
                //point_count: buf.readUInt32LE(0x08 + offset),
                //point_size: buf.readUInt32LE(0x0c + offset),
                current_angle: buf.readUInt32LE(0x10 + offset), //This is always 0. Roborock didn't bother
                points: points
            };

            type_based_offset = 0x0c;
            break;
        case RRMapParser.TYPES.GOTO_TARGET:
            result[type] = {
                position: [
                    buf.readUInt16LE(0x08 + offset),
                    buf.readUInt16LE(0x0a + offset)
                ]
            };
            break;
        case RRMapParser.TYPES.CURRENTLY_CLEANED_ZONES:
            const zoneCount = buf.readUInt32LE(0x08 + offset);
            const zones = [];

            if(zoneCount > 0) {
                for (let i = 0; i < length; i = i + 8) {
                    zones.push([
                        buf.readUInt16LE(0x0c + offset + i),
                        buf.readUInt16LE(0x0c + offset + i + 2),
                        buf.readUInt16LE(0x0c + offset + i + 4),
                        buf.readUInt16LE(0x0c + offset + i + 6)
                    ]);
                }

                result[type] = zones;
            }

            type_based_offset = 0x04;
            break;
        case RRMapParser.TYPES.FORBIDDEN_ZONES:
            const forbiddenZoneCount = buf.readUInt32LE(0x08 + offset);
            const forbiddenZones = [];

            if(forbiddenZoneCount > 0) {
                for (let i = 0; i < length; i = i + 16) {
                    forbiddenZones.push([
                        buf.readUInt16LE(0x0c + offset + i),
                        buf.readUInt16LE(0x0c + offset + i + 2),
                        buf.readUInt16LE(0x0c + offset + i + 4),
                        buf.readUInt16LE(0x0c + offset + i + 6),
                        buf.readUInt16LE(0x0c + offset + i + 8),
                        buf.readUInt16LE(0x0c + offset + i + 10),
                        buf.readUInt16LE(0x0c + offset + i + 12),
                        buf.readUInt16LE(0x0c + offset + i + 14)
                    ]);
                }

                result[type] = forbiddenZones;
            }

            type_based_offset = 0x04;
            break;
        case RRMapParser.TYPES.VIRTUAL_WALLS:
            const wallCount = buf.readUInt32LE(0x08 + offset);
            const walls = [];

            if(wallCount > 0) {
                for (let i = 0; i < length; i = i + 8) {
                    walls.push([
                        buf.readUInt16LE(0x0c + offset + i),
                        buf.readUInt16LE(0x0c + offset + i + 2),
                        buf.readUInt16LE(0x0c + offset + i + 4),
                        buf.readUInt16LE(0x0c + offset + i + 6)
                    ]);
                }

                result[type] = walls
            }

            type_based_offset = 0x04;
            break;
        case RRMapParser.TYPES.DIGEST:
            break;
        default: //TODO: Only enable for development since it will spam the log
            //console.error("Unknown Data Block of type " + type + " at offset " + offset + " with length " + length);
    }

    return parseBlock(buf, 0x08 + length + offset + type_based_offset, result);
};

/**
 *
 * @param inputMapBuf {UInt8Array} Should contain map in RRMap Format
 * @return {null|object}
 */
RRMapParser.PARSE = function parse(inputMapBuf) {
    if (inputMapBuf[0x00] === 0x72 && inputMapBuf[0x01] === 0x72) {// rr
        const mapBuf = new RRDataView(inputMapBuf.buffer);
        const blocks = RRMapParser.PARSE_BLOCK(mapBuf, 0x14);
        const parsedMapData = {
            header_length: mapBuf.readUInt16LE(0x02),
            data_length: mapBuf.readUInt16LE(0x04),
            version: {
                major: mapBuf.readUInt16LE(0x08),
                minor: mapBuf.readUInt16LE(0x0A)
            },
            map_index: mapBuf.readUInt16LE(0x0C),
            map_sequence: mapBuf.readUInt16LE(0x10)
        };
        if (blocks[RRMapParser.TYPES.IMAGE]) { //We need the image to flip everything else correctly
            parsedMapData.image = blocks[RRMapParser.TYPES.IMAGE];
            [
                {
                    type: RRMapParser.TYPES.PATH,
                    path: "path"
                },
                {
                    type: RRMapParser.TYPES.GOTO_PATH,
                    path: "goto_path"
                },
                {
                    type: RRMapParser.TYPES.GOTO_PREDICTED_PATH,
                    path: "goto_predicted_path"
                },
            ].forEach(item => {
                if (blocks[item.type]) {
                    parsedMapData[item.path] = blocks[item.type];
                    let len = parsedMapData[item.path].points.length;
                    for (let i = 0; i < len; i += 2) {
                        parsedMapData[item.path].points[i+1] = Tools.DIMENSION_MM - parsedMapData[item.path].points[i+1];
                    }
                    if (len >= 4) {
                        parsedMapData[item.path].current_angle =
                            Math.atan2(
                                parsedMapData[item.path].points[len - 1] - parsedMapData[item.path].points[len - 3],
                                parsedMapData[item.path].points[len - 2] - parsedMapData[item.path].points[len - 4],
                            ) * 180 / Math.PI;
                    }
                }
            });
            if (blocks[RRMapParser.TYPES.CHARGER_LOCATION]) {
                parsedMapData.charger = blocks[RRMapParser.TYPES.CHARGER_LOCATION].position;
                parsedMapData.charger[1] = Tools.DIMENSION_MM - parsedMapData.charger[1];
            }
            if (blocks[RRMapParser.TYPES.ROBOT_POSITION]) {
                parsedMapData.robot = blocks[RRMapParser.TYPES.ROBOT_POSITION].position;
                parsedMapData.robot[1] = Tools.DIMENSION_MM - parsedMapData.robot[1];
            }
            if(blocks[RRMapParser.TYPES.GOTO_TARGET]) {
                parsedMapData.goto_target = blocks[RRMapParser.TYPES.GOTO_TARGET].position;
                parsedMapData.goto_target[1] = Tools.DIMENSION_MM - parsedMapData.goto_target[1];
            }
            if(blocks[RRMapParser.TYPES.CURRENTLY_CLEANED_ZONES]) {
                parsedMapData.currently_cleaned_zones = blocks[RRMapParser.TYPES.CURRENTLY_CLEANED_ZONES];
                parsedMapData.currently_cleaned_zones = parsedMapData.currently_cleaned_zones.map(zone => {
                    zone[1] = Tools.DIMENSION_MM - zone[1];
                    zone[3] = Tools.DIMENSION_MM - zone[3];

                    return zone;
                });
            }
            if(blocks[RRMapParser.TYPES.FORBIDDEN_ZONES]) {
                parsedMapData.forbidden_zones = blocks[RRMapParser.TYPES.FORBIDDEN_ZONES];
                parsedMapData.forbidden_zones = parsedMapData.forbidden_zones.map(zone => {
                    zone[1] = Tools.DIMENSION_MM - zone[1];
                    zone[3] = Tools.DIMENSION_MM - zone[3];
                    zone[5] = Tools.DIMENSION_MM - zone[5];
                    zone[7] = Tools.DIMENSION_MM - zone[7];

                    return zone;
                })
            }
            if(blocks[RRMapParser.TYPES.VIRTUAL_WALLS]) {
                parsedMapData.virtual_walls = blocks[RRMapParser.TYPES.VIRTUAL_WALLS];
                parsedMapData.virtual_walls = parsedMapData.virtual_walls.map(wall => {
                    wall[1] = Tools.DIMENSION_MM - wall[1];
                    wall[3] = Tools.DIMENSION_MM - wall[3];

                    return wall;
                });
            }
            return parsedMapData;
        } else {
            return null;
        }
    } else {
        return null;
    }
};
