from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
import secrets
import json
import os
import eventlet

app = Flask(__name__)
app.config['SECRET_KEY'] = secrets.token_hex(16)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# SSL证书路径配置
SSL_CERT_PATH = '/www/server/panel/vhost/cert/xxx.你的域名.xyz/fullchain.pem'  # 替换为你的证书路径
SSL_KEY_PATH = '/www/server/panel/vhost/cert/xxx.你的域名.xyz/privkey.pem'     # 替换为你的私钥路径

# 存储在线设备信息
connected_devices = {}
DEVICES_FILE = 'devices.json'

# 加载已知设备列表
def load_devices():
    if os.path.exists(DEVICES_FILE):
        with open(DEVICES_FILE, 'r') as f:
            return json.load(f)
    return {}

# 保存设备列表
def save_devices(devices):
    with open(DEVICES_FILE, 'w') as f:
        json.dump(devices, f)

# 判断IP是否在同一局域网
def is_same_network(ip1, ip2):
    # 将IP地址转换为网段进行比较
    if ip1 == '127.0.0.1' and ip2 == '127.0.0.1':
        return True
    try:
        # 分割IP地址的前三段进行比较
        net1 = '.'.join(ip1.split('.')[:3])
        net2 = '.'.join(ip2.split('.')[:3])
        return net1 == net2
    except:
        return False

# 加载已知设备
known_devices = load_devices()

def get_real_ip():
    """获取真实的客户端IP地址"""
    # 按优先级依次尝试获取
    if request.headers.get('X-Real-IP'):
        return request.headers.get('X-Real-IP')
    elif request.headers.get('X-Forwarded-For'):
        # X-Forwarded-For可能包含多个IP，第一个是真实客户端IP
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('register_device')
def handle_register(data):
    device_uuid = data.get('uuid')
    device_name = data.get('name', '未命名设备')
    device_id = device_uuid[-6:]
    client_ip = get_real_ip()
    
    if device_uuid not in known_devices:
        known_devices[device_uuid] = {
            'id': device_id,
            'name': device_name,
            'last_ip': client_ip,
            'network': '.'.join(client_ip.split('.')[:3])
        }
        save_devices(known_devices)
    
    device_info = known_devices[device_uuid]
    device_info['last_ip'] = client_ip
    device_info['network'] = '.'.join(client_ip.split('.')[:3])
    save_devices(known_devices)
    
    connected_devices[request.sid] = {
        'uuid': device_uuid,
        'id': device_id,
        'name': device_info['name'],
        'ip': client_ip,
        'network': '.'.join(client_ip.split('.')[:3]),
        'sid': request.sid
    }
    
    socketio.emit('your_device_id', {
        'id': device_id,
        'name': device_info['name'],
        'uuid': device_uuid,
        'sid': request.sid,
        'network': '.'.join(client_ip.split('.')[:3])
    }, room=request.sid)
    
    update_device_list()

@socketio.on('heartbeat')
def handle_heartbeat(data):
    # 广播心跳包给同一网段的其他设备
    if request.sid in connected_devices:  # 确保是已注册的设备
        client_ip = get_real_ip()
        for sid, device in connected_devices.items():
            if is_same_network(client_ip, device['ip']):
                socketio.emit('heartbeat', {
                    'id': connected_devices[request.sid]['id'],
                    'timestamp': data['timestamp']
                }, room=sid)

@socketio.on('update_device_name')
def handle_name_update(data):
    device_uuid = data.get('uuid')
    new_name = data.get('name')
    
    if device_uuid in known_devices:
        known_devices[device_uuid]['name'] = new_name
        save_devices(known_devices)
        
        # 如果设备在线，更新连接设备信息
        for sid, device in connected_devices.items():
            if device['uuid'] == device_uuid:
                device['name'] = new_name
                break
        
        update_device_list()

@socketio.on('connect')
def handle_connect():
    print(f"新设备连接: {get_real_ip()}")

@socketio.on('disconnect')
def handle_disconnect():
    if request.sid in connected_devices:
        device_info = connected_devices[request.sid]
        del connected_devices[request.sid]
        update_device_list()
        print(f"设备断开连接: {device_info['name']} ({device_info['id']})")

def update_device_list():
    for sid, current_device in connected_devices.items():
        # 获取当前设备的IP
        current_ip = current_device['ip']
        
        # 筛选出同一局域网内的设备
        network_devices = [
            {
                'id': dev['id'],
                'name': dev['name'],
                'ip': dev['ip'],
                'sid': dev_sid
            }
            for dev_sid, dev in connected_devices.items()
             if is_same_network(current_ip, dev['ip']) 
        ]
        
        # 向当前设备发送过滤后的设备列表
        socketio.emit('update_devices', network_devices, room=sid)

@socketio.on('offer')
def handle_offer(data):
    target_id = data['targetId']
    for sid, device in connected_devices.items():
        if device['id'] == target_id:
            socketio.emit('offer', {
                'offer': data['offer'],
                'sourceId': connected_devices[request.sid]['id']
            }, room=sid)
            break

@socketio.on('answer')
def handle_answer(data):
    target_id = data['targetId']
    for sid, device in connected_devices.items():
        if device['id'] == target_id:
            socketio.emit('answer', {
                'answer': data['answer'],
                'sourceId': connected_devices[request.sid]['id']
            }, room=sid)
            break

@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    target_id = data['targetId']
    for sid, device in connected_devices.items():
        if device['id'] == target_id:
            socketio.emit('ice_candidate', {
                'candidate': data['candidate'],
                'sourceId': connected_devices[request.sid]['id']
            }, room=sid)
            break

if __name__ == '__main__':
    # 使用 eventlet 运行带有 SSL 的服务器

    eventlet.wsgi.server(
         eventlet.wrap_ssl(
             eventlet.listen(('0.0.0.0', 8384)),
            certfile=SSL_CERT_PATH,
            keyfile=SSL_KEY_PATH,
             server_side=True
         ),
        app,
        debug=True
    )
