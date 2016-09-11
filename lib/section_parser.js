"use strict";

const TsBase = require("./base");
const TsBuffer = require("./buffer");
const tsSectionList = require("./section");

class TsSectionParser extends TsBase {
    constructor() {
        super();

        this.info = {};
    }

    process(tsPacket) {
        // Check transport_error_indicator
        if (tsPacket.getTransportErrorIndicator() === 1) return;

        // Check scramble
        if (tsPacket.getTransportScramblingControl() >> 1 === 1) return;

        // Check data
        if (!tsPacket.hasData()) return;

        // Get pid
        const pid = tsPacket.getPid();

        // Add info
        if (!this.info.hasOwnProperty(pid)) {
            this.info[pid] = {
                counter: -1,
                duplication: 0,
                buffer: new TsBuffer()
            };
        }

        // Get info
        const info = this.info[pid];

        // Get counter
        const counter = tsPacket.getContinuityCounter();

        // Check discontinuity_indicator
        if (tsPacket.hasAdaptationField() &&
            tsPacket.getAdaptationFieldLength() > 0 &&
            tsPacket.getDiscontinuityIndicator() === 1) {
            // Reset counter
            info.counter = -1;
        }

        // Check drop
        if (info.counter !== -1 && pid !== 0x1FFF) {
            const previous = info.counter;
            const expected = (previous + 1) & 0x0F;
            let drop = false;

            // Set counter
            info.counter = counter;

            if (counter === previous) {
                // Increment duplication
                info.duplication++;

                if (info.duplication === 1) return;

                if (info.duplication > 1) {
                    drop = true;
                }
            } else {
                // Reset duplication
                info.duplication = 0;

                if (counter !== expected) {
                    drop = true;
                }
            }

            if (drop) {
                // Clear chunk
                info.buffer.clear();
                info.entireLength = 0;

                return;
            }
        } else {
            // Set counter
            info.counter = counter;
        }

        const sections = [];

        // Is first packet
        if (tsPacket.getPayloadUnitStartIndicator() === 1) {
            if (tsPacket.isPes()) {
                // PES
                info.type = 1;
            } else {
                // PSI/SI
                info.type = 2;

                const data = tsPacket.getData();
                let bytesRead = 0;

                const pointerField = data[0];
                bytesRead++;

                if (pointerField !== 0 && info.buffer.length !== 0) {
                    // Multi section
                    if (info.entireLength - info.buffer.length === pointerField) {
                        // Add buffer
                        info.buffer.add(data.slice(bytesRead, bytesRead + pointerField));

                        // Add section
                        sections.push(info.buffer.concat());
                    } else {
                        // Invalid data
                        info.type = 0;
                    }
                }

                if (info.buffer.length !== 0) {
                    // Clear chunk
                    info.buffer.clear();
                    info.entireLength = 0;
                }

                bytesRead += pointerField;

                while (data.length >= bytesRead + 3 && data[bytesRead] !== 0xFF) {
                    const sectionLength = 3 + ((data[bytesRead + 1] & 0x0F) << 8 | data[bytesRead + 2]);

                    if (data.length < bytesRead + sectionLength) {
                        // Add buffer
                        info.buffer.add(data.slice(bytesRead, data.length));
                        info.entireLength = sectionLength;
                        break;
                    }

                    // Add section
                    sections.push(data.slice(bytesRead, bytesRead + sectionLength));

                    bytesRead += sectionLength;
                }
            }
        } else {
            if (info.type === 1) {
                // PES
            } else if (info.type === 2) {
                // PSI/SI

                if (info.buffer.length !== 0) {
                    // Continuing section
                    const data = tsPacket.getData();
                    const remainingLength = info.entireLength - info.buffer.length;

                    if (data.length < remainingLength) {
                        // Add buffer
                        info.buffer.add(data);
                    } else {
                        // Add buffer
                        info.buffer.add(data.slice(0, remainingLength));

                        // Add section
                        sections.push(info.buffer.concat());

                        // Clear chunk
                        info.buffer.clear();
                        info.entireLength = 0;
                    }
                }
            }
        }

        const tsSections = [];

        for (let i = 0, l = sections.length; i < l; i++) {
            const section = sections[i];
            const tableId = section[0];

            if (tableId === 0x00) {
                // Program association
                const tsSection = new tsSectionList.TsSectionProgramAssociation(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("pat", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x01) {
                // Conditional access
                const tsSection = new tsSectionList.TsSectionConditionalAccess(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("cat", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x02) {
                // Program map
                const tsSection = new tsSectionList.TsSectionProgramMap(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("pmt", tsSection);

                tsSections.push(tsSection);
            } else if (tableId >= 0x3A && tableId <= 0x3F) {
                // DSM-CC
                const tsSection = new tsSectionList.TsSectionDsmcc(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("dsmcc", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x40 || tableId === 0x41) {
                // Network information
                const tsSection = new tsSectionList.TsSectionNetworkInformation(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("nit", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x42 || tableId === 0x46) {
                // Service description
                const tsSection = new tsSectionList.TsSectionServiceDescription(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("sdt", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x4A) {
                // Bouquet association
                const tsSection = new tsSectionList.TsSectionBouquetAssociation(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("bat", tsSection);

                tsSections.push(tsSection);
            } else if (tableId >= 0x4E && tableId <= 0x6F) {
                // Event information
                const tsSection = new tsSectionList.TsSectionEventInformation(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("eit", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x70) {
                // Time and date
                const tsSection = new tsSectionList.TsSectionTimeAndDate(section, pid);

                this.emit("tdt", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x73) {
                // Time offset
                const tsSection = new tsSectionList.TsSectionTimeOffset(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("tot", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x7E) {
                // Discontinuity information
                const tsSection = new tsSectionList.TsSectionDiscontinuityInformation(section, pid);

                this.emit("dit", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0x7F) {
                // Selection information
                const tsSection = new tsSectionList.TsSectionSelectionInformation(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("sit", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0xC3) {
                // Software download trigger
                const tsSection = new tsSectionList.TsSectionSoftwareDownloadTrigger(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("sdtt", tsSection);

                tsSections.push(tsSection);
            } else if (tableId === 0xC8) {
                // Common data
                const tsSection = new tsSectionList.TsSectionCommonData(section, pid);

                if (!tsSection.checkCrc32()) continue;

                this.emit("cdt", tsSection);

                tsSections.push(tsSection);
            }
        }

        for (let i = 0, l = tsSections.length; i < l; i++) {
            this.push(tsSections[i]);
        }
    }
}

module.exports = TsSectionParser;