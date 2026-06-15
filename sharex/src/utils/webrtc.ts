export const myPeerConnection:RTCConfiguration ={
  iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
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
  iceCandidatePoolSize:10
};

//API Key for the credential: c0050a97acee6b1592f380726c9cc96b7032

// Calling the REST API TO fetch the TURN Server Credentials
// const response = 
//   await fetch("https://massiveshare.metered.live/api/v1/turn/credentials?apiKey=c0050a97acee6b1592f380726c9cc96b7032");

// // Saving the response in the iceServers array
// const iceServers = await response.json();

// // Using the iceServers array in the RTCPeerConnection method
// var myPeerConnection = new RTCPeerConnection({
//   iceServers: iceServers
// });

