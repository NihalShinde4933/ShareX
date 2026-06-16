// rtcConfig.ts — shared RTCConfiguration using metered.ca TURN servers
 
export const rtcConfig: RTCConfiguration = {
    iceServers: [
        { urls: "stun:stun.relay.metered.ca:80" },
        {
            urls: "turn:global.relay.metered.ca:80",
            username: "e0cc3f9b125be6ec71358071",
            credential: "qVLEfeJurectlm79",
        },
        {
            urls: "turn:global.relay.metered.ca:80?transport=tcp",
            username: "e0cc3f9b125be6ec71358071",
            credential: "qVLEfeJurectlm79",
        },
        {
            urls: "turn:global.relay.metered.ca:443",
            username: "e0cc3f9b125be6ec71358071",
            credential: "qVLEfeJurectlm79",
        },
        {
            urls: "turns:global.relay.metered.ca:443?transport=tcp",
            username: "e0cc3f9b125be6ec71358071",
            credential: "qVLEfeJurectlm79",
        },
    ],
    iceCandidatePoolSize: 10,
};
 