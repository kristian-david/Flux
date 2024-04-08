const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { parse } = require('intel-hex');
const { CPU, avrInstruction, AVRIOPort, portBConfig,portDConfig, PinState, AVRTimer, timer0Config } = require('avr8js');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = 4004;

app.use(cors());
app.use(express.json());

let digitalPinStates = {
    pin0: false,
    pin1: false,
    pin2: false,
    pin3: false,
    pin4: false,
    pin5: false,
    pin6: false,
    pin7: false,
    pin13: false // Built-in LED
  };
  

// Placeholder code
let arduinoCode = `
bool builtInLedState = false; // Tracks the current state of the built-in LED
int lastButtonState = LOW;    // Tracks the last state of the button

void setup() {
  pinMode(7, OUTPUT);
  pinMode(6, OUTPUT);
  pinMode(13, OUTPUT); // Setup for built-in LED
  pinMode(2, INPUT);   // Setup for pushbutton
}

void loop() {
  // Blink LEDs on pin 6 and 7
  digitalWrite(7, HIGH);
  digitalWrite(6, HIGH);
  delay(1000);
  digitalWrite(7, LOW);
  digitalWrite(6, LOW);
  delay(1000);

  // Read the state of the pushbutton
  int buttonState = digitalRead(2);
  
  // Check if the button state changed from LOW to HIGH (button press)
  if (buttonState == HIGH && lastButtonState == LOW) {
    builtInLedState = !builtInLedState; // Toggle the state of the built-in LED
    digitalWrite(13, builtInLedState ? HIGH : LOW); // Set the built-in LED state
    delay(50); // Debounce delay
  }
  
  lastButtonState = buttonState; // Save the current state as the last state, for next time through the loop
}

`;

let simulationRunning = false;
let simulationShouldContinue = true;

let globalCpu = null;

async function compileAndRunCode(sketch) {
    stopSimulation();
    
    console.log("COMPILING...");
    // Compile the Arduino source code
    const result = await axios.post('https://hexi.wokwi.com/build', {
        sketch: sketch
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    const { hex, stderr } = result.data;
    if (!hex) {
        console.error(stderr);
        return;
    }

    const { data } = parse(hex);
    const progData = new Uint8Array(data);
    console.log(data);

    // Set up the simulation
    const cpu = new CPU(new Uint16Array(progData.buffer));
    globalCpu = cpu;

    // Attach the virtual hardware
    const portD = new AVRIOPort(cpu, portDConfig); // Port D for pins 6 and 7
    const portB = new AVRIOPort(cpu, portBConfig); // Port B for the built-in LED on pin 13

    const timer = new AVRTimer(cpu, timer0Config);


    // Reset control flags for new simulation
    simulationRunning = true;
    simulationShouldContinue = true;

    // Listen to Port D for pin 6 and 7 state changes
    portD.addListener(() => {
        for (let pin = 0; pin <= 7; pin++) {
            digitalPinStates[`pin${pin}`] = portD.pinState(pin) === PinState.High;
        }
        // console.log(`LED Pin 7: ${digitalPinStates.pin7 ? 'ON' : 'OFF'}, LED Pin 6: ${digitalPinStates.pin6 ? 'ON' : 'OFF'}`);
    });

    // Listen to Port B for the built-in LED state change
    portB.addListener(() => {
        digitalPinStates.pin13 = portB.pinState(5) === PinState.High; // Pin 13 is PB5 on Port B
        // console.log(`LED Builtin: ${digitalPinStates.pin13 ? 'ON' : 'OFF'}`);
    });



      
    // Run the simulation
    while (simulationShouldContinue) {
        for (let i = 0; i < 500000; i++) {
            if (!globalCpu) break;
            avrInstruction(cpu);
            timer.tick();
        }
        if (!globalCpu) break;
        sendPinStates();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    simulationRunning = false;
    console.log("Simulation stopped.");
}

// Function to send LED states to clients
function sendPinStates() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pin-states', ...digitalPinStates }));
        }
    });
    }

function stopSimulation() {
    console.log("Stop");
    if (simulationRunning) {
        simulationShouldContinue = false;
        globalCpu = null;
        console.log("Simulation stop requested.");
    }
}

// This function simulates changing the input state of a pin and reacting to it
function handleInputChange(pin, state) {
    console.log(`Simulating input change on pin ${pin} to state ${state}`);
    // For this example, let's assume pin 2 is connected to the built-in LED
    if (pin === 2) {
        // Toggle built-in LED based on the state
        digitalPinStates.pin13 = state; // Simulate the input directly changing the LED state
        sendPinStates(); // Immediately send updated states after handling input change
    }

}


// Create an HTTP server
const server = http.createServer(app);

// Create a WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', function connection(ws) {
    ws.on('message', function incoming(message) {
        console.log('received: %s', message);
        const data = JSON.parse(message);

        if (data.type === 'compile-run') {
            compileAndRunCode(data.sketch);
        } else if (data.type === 'stop-code') {
            stopSimulation();
        } else if (data.type === 'input-change') {
             // Assuming the message format is { type: 'input-change', pin: 2, state: true/false }
             handleInputChange(data.pin, data.state);
        }
    });

    // Send the placeholder code when a new client connects
    ws.send(JSON.stringify({ type: 'code', code: arduinoCode }));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

server.listen(4005, () => {
    console.log(`WebSocket Server running at http://localhost:4005`);
});
