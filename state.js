let latestQr = null;
let isReady = false;
let groups = [];
let groupDetailsById = {};

function setLatestQr(qr) {
    latestQr = qr;
}

function getLatestQr() {
    return latestQr;
}

function setIsReady(ready) {
    isReady = ready;
}

function getIsReady() {
    return isReady;
}

function setGroups(groupSummaries) {
    groups = Array.isArray(groupSummaries) ? groupSummaries : [];
}

function getGroups() {
    return groups;
}

function setGroupDetails(groupId, details) {
    if (!groupId) return;
    groupDetailsById[groupId] = details || {};
}

function getGroupDetails(groupId) {
    return groupDetailsById[groupId] || null;
}

module.exports = {
    setLatestQr,
    getLatestQr,
    setIsReady,
    getIsReady,
    setGroups,
    getGroups,
    setGroupDetails,
    getGroupDetails,
}; 