package main

import (
	"flag"
	"log"
	"math/rand"
	"net/http"

	"golang.org/x/net/websocket"
)

const clientBuffer = 100

type Client struct {
	User    int
	Receive chan ClientMessage
}
type ClientMessage struct {
	Contents    string
	Source      int
	Destination int
	Deliverable chan bool
}
type ClientManager struct {
	New    chan Client
	Delete chan Client
	Send   chan ClientMessage
}

func (cm *ClientManager) Run() {
	sessions := make(map[int](chan ClientMessage))
	newClient := func() Client {
		var uid int
		for uid == 0 || sessions[uid] != nil {
			uid = int(rand.Int31() >> 9) // 0-4194303
		}
		ch := make(chan ClientMessage, clientBuffer)
		sessions[uid] = ch
		return Client{User: uid, Receive: ch}
	}
	cm.New, cm.Delete = make(chan Client), make(chan Client)
	cm.Send = make(chan ClientMessage)
	go func() {
		for {
			select {
			case cm.New <- newClient():
			case client := <-cm.Delete:
				delete(sessions, client.User)
			case msg := <-cm.Send:
				ch, present := sessions[msg.Destination]
				if present {
					msg.Deliverable <- true
					ch <- msg
				} else {
					msg.Deliverable <- false
				}
			}
		}
	}()
}

var cm ClientManager

func SignalServer(ws *websocket.Conn) {
	c := <-cm.New
	defer func() { cm.Delete <- c }()
	type Message struct {
		Datab64 string
		Dest    int
		Id      int
	}
	type Ack struct {
		Deliverable bool
		You         int
		Id          int
	}
	type Delivery struct {
		Datab64 string
		Src     int
		Dest    int
	}
	read := make(chan Message)
	exit := make(chan int)
	go func() {
		for {
			var m Message
			err := websocket.JSON.Receive(ws, &m)
			if err != nil || m.Id == 0 {
				break
			}
			read <- m
		}
		exit <- 0
	}()
	for {
		select {
		case jm := <-read:
			ack := make(chan bool)
			cm.Send <- ClientMessage{
				Contents:    jm.Datab64,
				Source:      c.User,
				Destination: jm.Dest,
				Deliverable: ack}
			websocket.JSON.Send(ws, &Ack{Deliverable: <-ack, You: c.User, Id: jm.Id})
		case m := <-c.Receive:
			websocket.JSON.Send(ws, &Delivery{Datab64: m.Contents, Src: m.Source, Dest: c.User})
		case <-exit:
			break
		}
	}
}

func main() {
	pathPtr := flag.String("path", ".", "serve files from here")
	addrPtr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	cm.Run()
	http.Handle("/", http.FileServer(http.Dir(*pathPtr)))
	http.Handle("/signal", websocket.Handler(SignalServer))
	log.Fatal(http.ListenAndServe(*addrPtr, nil))
}
