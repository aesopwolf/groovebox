var config = require('./config'),
    gs = require('grooveshark'),
    client = new gs(config.clientUsername, config.clientPassword),
    lame = require('lame'),
    Speaker = require('speaker'),
    fs = require('fs'),
    http = require('http'),
    express = require('express'),
    wobot = require('wobot'),
    bodyParser = require('body-parser'),
    request = require('request'),
    ngrok = require('ngrok');

/*****************************
  GLOBALS
*****************************/
var app = express();
app.use(bodyParser.json());

var nextSong, myCountry;
var audioOptions = {channels: 2, bitDepth: 16, sampleRate: 44100};
var autoplayState, artist;

/*****************************
  HIPCHAT BOT
*****************************/
var bot = new wobot.Bot({
  jid: config.hipChatUser,
  password: config.hipChatPassword
});

bot.connect();

bot.onConnect(function() {
  bot.join(config.hipChatRoom, 0);
});

bot.onError(function(condition, text, stanza) {
  console.log(condition);
  console.log(text);
  // todo: setup papertrail logging
});

bot.onDisconnect(function() {
  console.log("disconnected");
})

/*****************************
  JUKEBOX
*****************************/
var jukebox = (function () {
  var decoder = lame.Decoder();
  var speaker = new Speaker(audioOptions);
  var playing, _mp3stream;

  return {
    stop: function() {
      console.log("stopping the music")
      _mp3stream.unpipe(speaker);
      speaker.end();

      _mp3stream.unpipe(decoder);
      decoder.end();
      playing = false;
    },
    play: function(url, getStreamKeyStreamServer, cb) {
      console.log("playing: ", playing);
      if(playing) {
          playing = false;

          _mp3stream.unpipe(speaker);
          speaker.end();
          _mp3stream.unpipe(decoder);
          decoder.end();

        setTimeout(function() {
          jukebox.play(url, getStreamKeyStreamServer);
        }, 2000)
      }
      else {
        http.get(url, function(res) {
          _mp3stream = res; //needed for m

          var playedFor30;

          // required: tell grooveshark we played the song for 30 seconds
          setTimeout(function() {
            var payload = {
              streamKey: getStreamKeyStreamServer.StreamKey,
              streamServerID: getStreamKeyStreamServer.StreamServerID,
              sessionID: client.sessionID
            };

            client.request('markStreamKeyOver30Secs', payload, function(err, status, body) {
              playedFor30 = true;
            });

          }, 30000);

          // play the music
          decoder = lame.Decoder();
          speaker = new Speaker(audioOptions);
          _mp3stream.pipe(decoder).pipe(speaker);
          playing = true;

          // music has stopped
          speaker.on('flush', function(){
            playing = false;

            var payload = {
              sessionID: client.sessionID,
              songID: nextSong.SongID,
              streamKey: getStreamKeyStreamServer.StreamKey,
              streamServerID: getStreamKeyStreamServer.StreamServerID
            };

            if(playedFor30) {
              client.request('markSongComplete', payload, function(err, status, body) {
                playMusic(autoplayState, artist);
              });
            }
          });
        });
      }
    }
  };
})();

/*****************************
  ROUTES
*****************************/
app.post('/hipchat', function(req, res) {
  var command = req.body.item.message.message.split(":");
  command = command[1].trim(); // pinback

  if(command === "stop") {
    jukebox.stop();
    var stuff = {
      "color": "red",
      "message": "Music stopped",
      "notify": false,
      "message_format": "text"
    };
    res.send(stuff);
  }
  else {
    client.request('getArtistSearchResults', {query: command, limit: 1}, function(err, status, body) {
      artist = body.artists[0].ArtistID;

      playMusic(undefined, artist, function(data) {
        var chatResponse = {
          "color": "green",
          "message": data.ArtistName + " - " + data.SongName,
          "notify": false,
          "message_format": "text"
        };
        res.send(chatResponse);
      });
    });
  };
});

app.get('/api/stop', function (req, res) {
  jukebox.stop();
  res.send('stop the music');
});

app.get('/api/play/:artist', function (request, response) {
  client.request('getArtistSearchResults', {query: request.params.artist, limit: 1}, function(err, status, body) {
    artist = body.artists[0].ArtistID;
    console.log(body);
    playMusic(undefined, artist, function(data) {
      response.send(data);
    });
  });
});

/*****************************
  HELPER FUNCTIONS
*****************************/
function playMusic(autoplayState, newArtist, cb) {
  var decoder = lame.Decoder();
  var speaker = new Speaker(audioOptions);

  // get a random song to play based on the newArtist seed
  client.request('startAutoplay', {"artistIDs":[newArtist], "songIDs":[], "autoplayState": autoplayState}, function(err, status, body) {
    var parameters = {
      songID: body.nextSong.SongID,
      country: myCountry,
      lowBitrate: false
    };

    // http://developers.grooveshark.com/tuts/autoplay
    // "You will need to store and send back the autoplayState with every following autoplay request."
    autoplayState = body.autoplayState;
    nextSong = body.nextSong;
    console.log(nextSong);

    // get the url to the mp3 stream
    client.request('getStreamKeyStreamServer', parameters, function(err, status, body) {
      var getStreamKeyStreamServer = body;
      jukebox.play(body.url, getStreamKeyStreamServer, function(nextSong) {
        if(cb) cb(nextSong);
      });
      if(cb) cb(nextSong);
    })
  });
};

var server = app.listen(3000, function() {
  console.log("listening on port 3000");
  client.authenticate(config.userEmail, config.userPassword, function(err, body) {
    if(!err) {
      client.request('getCountry', {}, function(err, status, body) {
        myCountry = body;
      })
    }
  });
});

ngrok.connect({
  authtoken: config.ngrokAuthToken,
  subdomain: 'zocdev',
  port: 3000
}, function (err, url) {
  console.log(err, url);
});
