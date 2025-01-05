const socket = io({
    transports: ['websocket'],
    cors: { origin: "*" },
    secure: true
});

let currentDeviceId = null;
let deviceUUID = null;
const CHUNK_SIZE = 16384; // 16KB chunks
let peerConnections = new Map();

// 心跳检测相关变量
const HEARTBEAT_INTERVAL = 3000; // 发送心跳包的间隔（3秒）
const DEVICE_TIMEOUT = 8000;     // 设备超时时间（8秒）
let deviceLastSeen = new Map();  // 记录设备最后活跃时间
let heartbeatTimer = null;       // 心跳定时器
let statusCheckTimer = null;     // 状态检查定时器

// 速度计算相关变量
let sendStartTime = 0;
let receiveStartTime = 0;
let lastSendBytes = 0;
let lastReceiveBytes = 0;
let lastSendTime = 0;
let lastReceiveTime = 0;

// 添加一个新的 Map 来存储设备信息
let deviceInfoMap = new Map(); // 新增：用于存储设备信息

// 在文件开头的全局变量部分添加
let messageChannel = null;

// 在文件开头添加全局变量
let isPageVisible = true;

// 添加页面可见性监听
document.addEventListener('visibilitychange', () => {
    isPageVisible = document.visibilityState === 'visible';
    if (isPageVisible) {
        // 页面变为可见时，恢复正常的缓冲区阈值
        currentBufferThreshold = BUFFER_THRESHOLD;
    } else {
        // 页面在后台时，增加缓冲区阈值以减少节流影响
        currentBufferThreshold = BUFFER_THRESHOLD * 4;
    }
});

// 生成或获取设备UUID
function getDeviceUUID() {
    let uuid = localStorage.getItem('deviceUUID');
    if (!uuid) {
        uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('deviceUUID', uuid);
    }
    return uuid;
}

// 获取设备名称
function getDeviceName() {
    let name = localStorage.getItem('deviceName');
    if (!name) {
        name = `设备_${Math.random().toString(36).substr(2, 6)}`;
        localStorage.setItem('deviceName', name);
    }
    return name;
}

// 心跳相关函数
function startHeartbeat() {
    // 清除可能存在的旧定时器
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
    }
    if (statusCheckTimer) {
        clearInterval(statusCheckTimer);
    }

    // 发送心跳
    function sendHeartbeat() {
        if (socket.connected) {
            socket.emit('heartbeat', {
                id: currentDeviceId,
                timestamp: Date.now()
            });
        }
    }

    // 立即发送一次心跳
    sendHeartbeat();
    
    // 设置定时发送心跳
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    // 启动设备状态检查
    statusCheckTimer = setInterval(() => {
        const now = Date.now();
        let hasChanges = false;
        deviceLastSeen.forEach((lastSeen, deviceId) => {
            if (now - lastSeen > DEVICE_TIMEOUT) {
                // 设备超时，从本地列表中移除
                deviceLastSeen.delete(deviceId);
                hasChanges = true;
            }
        });
        if (hasChanges) {
            updateLocalDeviceList();
        }
    }, 2000); // 每2秒检查一次
}

// 更新本地设备列表显示
function updateLocalDeviceList() {
    const deviceList = document.getElementById('deviceList');
    const targetDevice = document.getElementById('targetDevice');
    const messageTarget = document.getElementById('messageTarget'); // 新增
    
    deviceList.innerHTML = '';
    targetDevice.innerHTML = '<option value="">选择目标设备...</option>';
    messageTarget.innerHTML = '<option value="">选择目标设备...</option>'; // 新增
    
    const onlineDevices = Array.from(deviceLastSeen.entries())
        .filter(([deviceId, lastSeen]) => Date.now() - lastSeen <= DEVICE_TIMEOUT)
        .map(([deviceId]) => deviceId);

    onlineDevices.forEach(deviceId => {
        const device = findDeviceById(deviceId);
        if (device) {
            const li = document.createElement('li');
            if (device.id === currentDeviceId) {
                li.textContent = `${device.name} [本机]`;
                li.style.color = 'blue';
                li.style.fontWeight = 'bold';
            } else {
                li.textContent = device.name;
                // 添加到文件传输目标选择器
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name;
                targetDevice.appendChild(option);
                
                // 添加到消息目标选择器
                const msgOption = document.createElement('option');
                msgOption.value = device.id;
                msgOption.textContent = device.name;
                messageTarget.appendChild(msgOption);
            }
            deviceList.appendChild(li);
        }
    });
}

// 查找设备信息的辅助函数
function findDeviceById(deviceId) {
    return deviceInfoMap.get(deviceId); // 修改：直接从 deviceInfoMap 获取设备信息
}
// WebRTC 配置
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// 连接状态处理
socket.on('connect', () => {
    console.log('已连接到服务器');
    deviceUUID = getDeviceUUID();
    const deviceName = getDeviceName();
    
    socket.emit('register_device', {
        uuid: deviceUUID,
        name: deviceName
    });
    
    updateStatus('sendStatus', '已连接到服务器', 'success');
});

socket.on('disconnect', () => {
    console.log('与服务器断开连接');
    updateStatus('sendStatus', '与服务器断开连接', 'error');
    
    // 清理心跳相关定时器
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (statusCheckTimer) {
        clearInterval(statusCheckTimer);
        statusCheckTimer = null;
    }
    
    // 清理设备列表
    deviceLastSeen.clear();
    deviceInfoMap.clear(); // 新增：清理设备信息
    updateLocalDeviceList();
    peerConnections.clear();
});

// 更新设备名称
function updateDeviceName() {
    const newName = prompt('请输入新的设备名称:', localStorage.getItem('deviceName'));
    if (newName && newName.trim()) {
        localStorage.setItem('deviceName', newName);
        socket.emit('update_device_name', {
            uuid: deviceUUID,
            name: newName
        });
    }
}

// 设备ID处理
socket.on('your_device_id', (data) => {
    currentDeviceId = data.id;
    document.getElementById('currentDevice').innerHTML = 
        `${data.name} <button onclick="updateDeviceName()">修改名称</button>`;
    
    // 启动心跳机制
    startHeartbeat();
});

// 设备列表更新
socket.on('update_devices', (devices) => {
    // 更新设备最后活跃时间和设备信息
    devices.forEach(device => {
        deviceLastSeen.set(device.id, Date.now());
        deviceInfoMap.set(device.id, device); // 新增：保存设备信息
    });
    
    // 更新显示
    updateLocalDeviceList();
});

// 心跳包接收处理
socket.on('heartbeat', (data) => {
    // 更新设备最后活跃时间
    deviceLastSeen.set(data.id, Date.now());
});

// WebRTC 信令处理
socket.on('offer', async (data) => {
    try {
        const pc = createPeerConnection(data.sourceId);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', {
            targetId: data.sourceId,
            answer: answer
        });
    } catch (error) {
        console.error('处理offer错误:', error);
        updateStatus('receiveStatus', '连接错误', 'error');
    }
});

socket.on('answer', async (data) => {
    try {
        const pc = peerConnections.get(data.sourceId);
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    } catch (error) {
        console.error('处理answer错误:', error);
        updateStatus('sendStatus', '连接错误', 'error');
    }
});

socket.on('ice_candidate', async (data) => {
    try {
        const pc = peerConnections.get(data.sourceId);
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    } catch (error) {
        console.error('处理ICE候选错误:', error);
    }
});

// 创建 WebRTC 连接
function createPeerConnection(targetId) {
    if (peerConnections.has(targetId)) {
        peerConnections.get(targetId).close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(targetId, pc);

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice_candidate', {
                targetId: targetId,
                candidate: event.candidate
            });
        }
    };

    pc.ondatachannel = event => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        setupDataChannel(channel);
    };

    return pc;
}

// 在文件开头添加速度计算函数
function calculateCurrentSpeed() {
    const now = Date.now();
    if (lastSendTime === 0) return 0;
    
    const bytesSent = lastSendBytes;
    const timeElapsed = (now - lastSendTime) / 1000; // 转换为秒
    return bytesSent / timeElapsed;
}

// 修改 setupSendChannel 函数
function setupSendChannel(channel, file) {
    const BUFFER_THRESHOLD = 1048576; // 1MB
    const CHUNK_DELAY = 5;
    let currentBufferThreshold = isPageVisible ? BUFFER_THRESHOLD : BUFFER_THRESHOLD * 4;
    let sending = true;
    let fileTransferComplete = false;
    let offset = 0;
    let waitingForConfirmation = false;
    let isReading = false;  // 新增：标记是否正在读取文件
    
    const sentChunks = new Map();
    let chunkIndex = 0;
    
    const reader = new FileReader();
    
    // 修改读取切片函数
    const readSlice = (o) => {
        if (!sending || isReading) return; // 如果正在读取则直接返回
        isReading = true;  // 设置读取标记
        const slice = file.slice(o, Math.min(o + CHUNK_SIZE, file.size));
        reader.readAsArrayBuffer(slice);
    };

    // 修改延迟发送函数
    const sendWithDelay = (chunkData, meta) => {
        return new Promise((resolve) => {
            // 根据页面可见性调整延迟
            const actualDelay = isPageVisible ? CHUNK_DELAY : CHUNK_DELAY / 2;
            setTimeout(() => {
                if (channel.readyState === 'open') {
                    try {
                        channel.send(JSON.stringify(meta));
                        channel.send(chunkData);
                        resolve(true);
                    } catch (error) {
                        console.error('发送数据块失败:', error);
                        resolve(false);
                    }
                } else {
                    resolve(false);
                }
            }, actualDelay);
        });
    };

    // 添加检查缓冲区和继续发送的函数
    const checkBufferAndContinue = () => {
        if (!sending || isReading) return;
        
        const threshold = isPageVisible ? currentBufferThreshold / 2 : currentBufferThreshold / 4;
        if (channel.bufferedAmount < threshold) {
            console.log(`缓冲区已降至${formatSize(channel.bufferedAmount)}，继续发送`);
            sending = true;
            readSlice(offset);
        } else {
            setTimeout(checkBufferAndContinue, 100);
        }
    };

    reader.onload = async (e) => {
        try {
            isReading = false;  // 重置读取标记
            if (!sending) return;

            const chunkData = {
                index: chunkIndex,
                data: e.target.result,
                offset: offset
            };
            
            sentChunks.set(chunkIndex, chunkData);
            
            // 使用延迟发送
            const sendSuccess = await sendWithDelay(e.target.result, {
                type: 'chunk-meta',
                index: chunkIndex,
                offset: offset,
                size: e.target.result.byteLength
            });

            if (!sendSuccess) {
                console.log('发送失败，暂停发送');
                sending = false;
                return;
            }
            
            offset += e.target.result.byteLength;
            chunkIndex++;
            updateSendProgress(offset, file.size);

            if (offset < file.size) {
                if (channel.bufferedAmount > currentBufferThreshold) {
                    console.log(`缓冲区已满(${formatSize(channel.bufferedAmount)})，暂停发送`);
                    sending = false;
                    setTimeout(checkBufferAndContinue, 100);
                } else {
                    setTimeout(() => readSlice(offset), CHUNK_DELAY);
                }
            } else {
                console.log('文件发送完成，等待接收端确认');
                waitingForConfirmation = true;
                channel.send(JSON.stringify({
                    type: 'transfer-complete',
                    totalSize: file.size,
                    totalChunks: chunkIndex
                }));
            }
        } catch (error) {
            isReading = false;  // 确保在错误时也重置读取标记
            console.error('发送文件块时出错:', error);
            updateStatus('sendStatus', '发送错误: ' + error.message, 'error');
            sending = false;
        }
    };

    reader.onerror = (error) => {
        isReading = false;  // 确保在错误时也重置读取标记
        console.error('读取文件错误:', error);
        updateStatus('sendStatus', '读取文件错误', 'error');
        sending = false;
    };

    // 处理重传请求
    channel.onmessage = (event) => {
        try {
            if (typeof event.data === 'string') {
                const data = JSON.parse(event.data);
                if (data.type === 'transfer-confirmation' && waitingForConfirmation) {
                    console.log('接收到传输完成确认');
                    fileTransferComplete = true;
                    sentChunks.clear(); // 清理缓存
                    setTimeout(() => {
                        if (channel.readyState === 'open') {
                            channel.close();
                        }
                    }, 1000);
                    updateStatus('sendStatus', '文件发送完成', 'success');
                } else if (data.type === 'chunk-request') {
                    // 处理重传请求
                    console.log(`重传数据块: ${data.index}`);
                    const chunk = sentChunks.get(data.index);
                    if (chunk) {
                        channel.send(JSON.stringify({
                            type: 'chunk-meta',
                            index: chunk.index,
                            offset: chunk.offset,
                            size: chunk.data.byteLength,
                            isRetry: true
                        }));
                        channel.send(chunk.data);
                    }
                }
            }
        } catch (error) {
            console.error('处理消息时出错:', error);
        }
    };

    channel.onopen = async () => {
        try {
            console.log('数据通道已打开，准备发送文件');
            updateStatus('sendStatus', '开始发送文件...', 'success');
            
            // 发送文件信息
            const fileInfo = {
                type: 'file-info',
                name: file.name,
                size: file.size,
                fileType: file.type
            };
            
            channel.send(JSON.stringify(fileInfo));
            await new Promise(resolve => setTimeout(resolve, 500));

            // 设置缓冲区阈值
            channel.bufferedAmountLowThreshold = currentBufferThreshold / 2;
            
            // 当缓冲区低于阈值时继续发送
            channel.onbufferedamountlow = () => {
                if (!sending && offset < file.size) {
                    console.log(`缓冲区低于阈值(${formatSize(channel.bufferedAmount)})，继续发送`);
                    sending = true;
                    readSlice(offset);
                }
            };

            sending = true;
            readSlice(0);
        } catch (error) {
            console.error('设置发送通道时出错:', error);
            updateStatus('sendStatus', '发送错误: ' + error.message, 'error');
        }
    };

    channel.onclose = () => {
        console.log('数据通道已关闭');
        if (!fileTransferComplete) {
            updateStatus('sendStatus', '连接意外关闭，传输未完成', 'error');
        } else {
            updateStatus('sendStatus', 'P2P连接已关闭', 'success');
        }
        sending = false;
    };

    channel.onerror = (error) => {
        console.error('数据通道错误:', error);
        updateStatus('sendStatus', '传输错误', 'error');
        sending = false;
    };
}

// 修改 setupDataChannel 函数
function setupDataChannel(channel) {
    if (channel.label === 'messageTransfer') {
        setupMessageChannel(channel);
        messageChannel = channel;
        return;
    }
    
    let receiveBuffer = [];
    let receivedSize = 0;
    let fileInfo = null;
    let isTransferring = false;
    let expectedChunks = new Set();
    let currentChunkMeta = null;
    let receivedChunkSizes = new Map(); // 新增：记录每个块的实际大小
    
    // 新增：重新计算实际接收大小的函数
    const recalculateReceivedSize = () => {
        receivedSize = 0;
        for (const [_, size] of receivedChunkSizes) {
            receivedSize += size;
        }
        return receivedSize;
    };
    
    channel.onmessage = async (event) => {
        try {
            const message = event.data;
            
            if (typeof message === 'string') {
                try {
                    const data = JSON.parse(message);
                    if (data.type === 'file-info') {
                        fileInfo = data;
                        isTransferring = true;
                        console.log('收到文件信息:', fileInfo);
                        updateStatus('receiveStatus', `准备接收文件: ${fileInfo.name}`, 'success');
                        return;
                    } else if (data.type === 'chunk-meta') {
                        currentChunkMeta = data;
                        expectedChunks.add(data.index);
                        return;
                    } else if (data.type === 'transfer-complete') {
                        // 重新计算实际接收大小
                        const actualReceivedSize = recalculateReceivedSize();
                        console.log(`校验大小 - 预期: ${data.totalSize}, 实际: ${actualReceivedSize}`);
                        
                        // 检查是否有丢失的数据块
                        if (actualReceivedSize === data.totalSize) {
                            console.log('文件接收完成，发送确认');
                            channel.send(JSON.stringify({
                                type: 'transfer-confirmation'
                            }));
                            
                            // 处理文件下载
                            const received = new Blob(receiveBuffer.filter(chunk => chunk), { type: fileInfo.fileType });
                            receiveBuffer = [];
                            receivedSize = 0;
                            receivedChunkSizes.clear();
                            isTransferring = false;

                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(received);
                            a.download = fileInfo.name;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(a.href);

                            updateStatus('receiveStatus', '文件接收完成', 'success');
                            fileInfo = null;
                            expectedChunks.clear();
                            currentChunkMeta = null;
                        } else {
                            console.log('检测到丢失或不完整的数据块，请求重传');
                            // 检查丢失的数据块
                            for (let i = 0; i < data.totalChunks; i++) {
                                if (!receivedChunkSizes.has(i) || 
                                    (currentChunkMeta && i === currentChunkMeta.index && 
                                     receivedChunkSizes.get(i) !== currentChunkMeta.size)) {
                                    console.log(`请求重传数据块: ${i}`);
                                    channel.send(JSON.stringify({
                                        type: 'chunk-request',
                                        index: i
                                    }));
                                }
                            }
                        }
                        return;
                    }
                } catch (e) {
                    console.error('解析消息失败:', e);
                    return;
                }
            }

            // 处理二进制数据
            if (message instanceof ArrayBuffer && currentChunkMeta) {
                receiveBuffer[currentChunkMeta.index] = new Uint8Array(message);
                receivedChunkSizes.set(currentChunkMeta.index, message.byteLength);
                receivedSize = recalculateReceivedSize();
                updateReceiveProgress(receivedSize, fileInfo.size);
                currentChunkMeta = null;
            }
        } catch (error) {
            console.error('处理接收数据时出错:', error);
            updateStatus('receiveStatus', '接收错误: ' + error.message, 'error');
        }
    };

    channel.onclose = () => {
        console.log('数据通道已关闭');
        if (isTransferring && receivedSize !== fileInfo?.size) {
            updateStatus('receiveStatus', '连接已关闭，传输未完成', 'error');
        }
        // 清理资源
        receiveBuffer = [];
        receivedSize = 0;
        receivedChunkSizes.clear();
        fileInfo = null;
        isTransferring = false;
        expectedChunks.clear();
        currentChunkMeta = null;
    };

    channel.onerror = (error) => {
        console.error('数据通道错误:', error);
        updateStatus('receiveStatus', '传输错误', 'error');
        // 清理资源
        receiveBuffer = [];
        receivedSize = 0;
        receivedChunkSizes.clear();
        fileInfo = null;
        isTransferring = false;
        expectedChunks.clear();
        currentChunkMeta = null;
    };
}

// 发送文件
async function sendFile() {
    const fileInput = document.getElementById('fileInput');
    const targetDevice = document.getElementById('targetDevice');
    
    if (!fileInput.files.length || !targetDevice.value) {
        updateStatus('sendStatus', '请选择文件和目标设备', 'error');
        return;
    }
    
    const file = fileInput.files[0];
    const targetId = targetDevice.value;

    try {
        const pc = createPeerConnection(targetId);
        const channel = pc.createDataChannel('fileTransfer', {
            ordered: true,
            maxRetransmits: 30  // 只保留重传次数限制，移除包生命周期限制
        });
        
        channel.binaryType = 'arraybuffer';
        setupSendChannel(channel, file);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
            targetId: targetId,
            offer: offer
        });

        updateStatus('sendStatus', '正在建立P2P连接...', 'success');
        resetSendProgress();
    } catch (error) {
        console.error('发送文件错误:', error);
        updateStatus('sendStatus', '发送错误', 'error');
    }
}

// 格式化工具函数
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
    return formatSize(bytesPerSecond) + '/s';
}

// 更新进度和速度显示
function updateSendProgress(sent, total) {
    const now = Date.now();
    const progress = (sent / total) * 100;
    
    document.getElementById('sendProgress').style.width = `${progress}%`;
    document.getElementById('sendProgressText').textContent = `${progress.toFixed(1)}%`;
    document.getElementById('sendSize').textContent = `${formatSize(sent)} / ${formatSize(total)}`;
    
    if (lastSendTime === 0) {
        sendStartTime = now;
        lastSendTime = now;
        lastSendBytes = 0;
    } else if (now - lastSendTime >= 1000) {
        const speed = (sent - lastSendBytes) * 1000 / (now - lastSendTime);
        document.getElementById('sendSpeed').textContent = formatSpeed(speed);
        lastSendTime = now;
        lastSendBytes = sent;
    }
}

function updateReceiveProgress(received, total) {
    const now = Date.now();
    const progress = (received / total) * 100;
    
    document.getElementById('receiveProgress').style.width = `${progress}%`;
    document.getElementById('receiveProgressText').textContent = `${progress.toFixed(1)}%`;
    document.getElementById('receiveSize').textContent = `${formatSize(received)} / ${formatSize(total)}`;
    
    if (lastReceiveTime === 0) {
        receiveStartTime = now;
        lastReceiveTime = now;
        lastReceiveBytes = 0;
    } else if (now - lastReceiveTime >= 1000) {
        const speed = (received - lastReceiveBytes) * 1000 / (now - lastReceiveTime);
        document.getElementById('receiveSpeed').textContent = formatSpeed(speed);
        lastReceiveTime = now;
        lastReceiveBytes = received;
    }
}

// 重置进度显示
function resetSendProgress() {
    document.getElementById('sendProgress').style.width = '0%';
    document.getElementById('sendProgressText').textContent = '0%';
    document.getElementById('sendSpeed').textContent = '0 B/s';
    document.getElementById('sendSize').textContent = '0 B / 0 B';
    lastSendTime = 0;
    lastSendBytes = 0;
}

function updateStatus(elementId, message, type) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.className = `status ${type}`;
}

// 添加文件校验和机制
function calculateFileChecksum(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            // 使用 SHA-256 计算校验和
            crypto.subtle.digest('SHA-256', buffer)
                .then(hash => {
                    resolve(Array.from(new Uint8Array(hash))
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join(''));
                });
        };
        reader.readAsArrayBuffer(file);
    });
}

// 添加断点续传支持
const transferState = {
    chunks: new Map(),
    lastChunkId: 0,
    fileChecksum: '',
    
    saveState() {
        localStorage.setItem('transferState', JSON.stringify({
            fileInfo: this.fileInfo,
            lastChunkId: this.lastChunkId,
            checksum: this.fileChecksum
        }));
    },
    
    loadState() {
        const saved = localStorage.getItem('transferState');
        if (saved) {
            const state = JSON.parse(saved);
            Object.assign(this, state);
            return true;
        }
        return false;
    }
};

// 添加消息发送函数
async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const targetDevice = document.getElementById('messageTarget');
    
    if (!messageInput.value.trim() || !targetDevice.value) {
        alert('请输入消息并选择目标设备');
        return;
    }
    
    const message = messageInput.value.trim();
    const targetId = targetDevice.value;

    try {
        let pc;
        let retryCount = 0;
        const maxRetries = 3;
        
        if (!peerConnections.has(targetId)) {
            pc = createPeerConnection(targetId);
            messageChannel = pc.createDataChannel('messageTransfer', {
                ordered: true
            });
            setupMessageChannel(messageChannel);
            
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', {
                targetId: targetId,
                offer: offer
            });
        } else {
            pc = peerConnections.get(targetId);
            if (!messageChannel || messageChannel.readyState !== 'open') {
                messageChannel = pc.createDataChannel('messageTransfer', {
                    ordered: true
                });
                setupMessageChannel(messageChannel);
            }
        }

        // 等待通道打开
        while (messageChannel.readyState !== 'open' && retryCount < maxRetries) {
            console.log(`等待数据通道打开，尝试次数：${retryCount + 1}`);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('等待通道打开超时'));
                }, 2000);
                
                messageChannel.onopen = () => {
                    clearTimeout(timeout);
                    resolve();
                };
            }).catch(error => {
                console.warn('等待超时，重试...', error);
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw new Error('数据通道无法建立，请重试');
                }
            });
        }

        if (messageChannel.readyState !== 'open') {
            throw new Error('无法建立连接，请重试');
        }

        // 发送消息
        const messageData = {
            type: 'text-message',
            content: message,
            timestamp: Date.now(),
            sender: {
                id: currentDeviceId,
                name: findDeviceById(currentDeviceId).name
            }
        };
        
        messageChannel.send(JSON.stringify(messageData));
        addMessageToHistory(messageData, true);
        messageInput.value = '';
        
    } catch (error) {
        console.error('发送消息错误:', error);
        // 使用更友好的错误提示
        const errorMsg = error.message.includes('无法建立连接') ? 
            '连接不稳定，请稍后重试' : 
            '发送失败，请重新选择设备并重试';
        alert(errorMsg);
        
        // 如果连接有问题，清理旧连接
        if (messageChannel) {
            messageChannel.close();
            messageChannel = null;
        }
        if (peerConnections.has(targetId)) {
            peerConnections.get(targetId).close();
            peerConnections.delete(targetId);
        }
    }
}

// 添加消息通道设置函数
function setupMessageChannel(channel) {
    channel.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'text-message') {
                addMessageToHistory(data, false);
            }
        } catch (error) {
            console.error('处理消息错误:', error);
        }
    };

    channel.onclose = () => {
        console.log('消息通道已关闭');
    };

    channel.onerror = (error) => {
        console.error('消息通道错误:', error);
    };
}

// 添加消息显示函数
function addMessageToHistory(messageData, isSent) {
    const messageHistory = document.getElementById('messageHistory');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isSent ? 'message-sent' : 'message-received'}`;
    
    const time = new Date(messageData.timestamp).toLocaleTimeString();
    const name = messageData.sender.name;
    
    // 添加复制按钮和消息内容
    messageDiv.innerHTML = `
        <button class="copy-button" onclick="copyMessage(this)" title="复制消息">
            <i class="ri-file-copy-line"></i>
        </button>
        <div class="message-content">${messageData.content}</div>
        <div class="message-meta">${name} - ${time}</div>
    `;
    
    messageHistory.appendChild(messageDiv);
    messageHistory.scrollTop = messageHistory.scrollHeight;
}

// 修改复制功能函数
function copyMessage(button) {
    const messageContent = button.nextElementSibling.textContent;
    
    // 尝试使用现代 Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(messageContent)
            .then(() => showCopyTooltip())
            .catch(err => {
                console.error('Clipboard API 失败，尝试备用方法:', err);
                fallbackCopy(messageContent);
            });
    } else {
        // 使用备用复制方法
        fallbackCopy(messageContent);
    }
}

// 添加备用复制方法
function fallbackCopy(text) {
    try {
        // 创建临时文本区域
        const textArea = document.createElement('textarea');
        textArea.value = text;
        
        // 设置样式使其不可见
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        textArea.style.opacity = '0';
        
        document.body.appendChild(textArea);
        
        // 选择并复制文本
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
            showCopyTooltip();
        } else {
            console.error('复制失败');
            alert('复制失败，请手动复制');
        }
    } catch (err) {
        console.error('复制出错:', err);
        alert('复制失败，请手动复制');
    }
}

// 添加复制成功提示函数
function showCopyTooltip() {
    // 创建或获取提示元素
    let tooltip = document.querySelector('.copy-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'copy-tooltip';
        document.body.appendChild(tooltip);
    }
    
    // 显示提示
    tooltip.textContent = '已复制到剪贴板';
    tooltip.classList.add('show');
    
    // 2秒后隐藏提示
    setTimeout(() => {
        tooltip.classList.remove('show');
    }, 2000);
}

// 在页面加载时添加复制提示元素
document.addEventListener('DOMContentLoaded', () => {
    const tooltip = document.createElement('div');
    tooltip.className = 'copy-tooltip';
    document.body.appendChild(tooltip);
});
