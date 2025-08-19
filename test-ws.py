#!/usr/bin/env python3

import asyncio
import websockets
import json
import sys

async def test_websocket():
    room_id = "test-room-" + str(asyncio.get_event_loop().time())
    
    uri = "ws://localhost:3000/ws"
    headers = {
        "Origin": "http://localhost:5173"
    }
    
    try:
        async with websockets.connect(uri, extra_headers=headers) as websocket:
            print(f"✓ Connected to WebSocket server")
            
            # Send room identification
            await websocket.send(json.dumps({"roomId": room_id}))
            print(f"✓ Sent room ID: {room_id}")
            
            # Wait for messages
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                print(f"✓ Received message: {message[:100] if len(message) > 100 else message}")
            except asyncio.TimeoutError:
                print("✓ No immediate message (normal for initial connection)")
            
            # Send a test message
            test_msg = json.dumps({"type": "test", "data": "hello"})
            await websocket.send(test_msg)
            print(f"✓ Sent test message")
            
            # Close connection
            await websocket.close()
            print("✓ Connection closed cleanly")
            
    except Exception as e:
        print(f"✗ WebSocket error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(test_websocket())