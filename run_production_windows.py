"""
Production WSGI Runner for Windows (Waitress)
Serves SheetLayout AI across local network / office intranet.
"""
from waitress import serve
from app import app
import socket

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

if __name__ == "__main__":
    local_ip = get_local_ip()
    port = 5000
    print("=" * 60)
    print(" SheetLayout AI — Production Server Running (Waitress)")
    print("=" * 60)
    print(f" Local Access:   http://localhost:{port}")
    print(f" Network Access: http://{local_ip}:{port}")
    print(" (Colleagues on the same WiFi/LAN can access via Network URL)")
    print("=" * 60)
    serve(app, host="0.0.0.0", port=port, threads=6)
