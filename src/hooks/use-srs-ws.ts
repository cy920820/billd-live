import { getRandomString } from 'billd-utils';
import { computed, onUnmounted, ref } from 'vue';

import { fetchRtcV1Publish } from '@/api/srs';
import { SRS_CB_URL_PARAMS, WEBSOCKET_URL } from '@/constant';
import {
  DanmuMsgTypeEnum,
  IDanmu,
  ILiveUser,
  IUser,
  LiveRoomTypeEnum,
} from '@/interface';
import {
  WSGetRoomAllUserType,
  WsAnswerType,
  WsCandidateType,
  WsConnectStatusEnum,
  WsDisableSpeakingType,
  WsGetLiveUserType,
  WsHeartbeatType,
  WsJoinType,
  WsLeavedType,
  WsMessageType,
  WsMsgTypeEnum,
  WsOfferType,
  WsOtherJoinType,
  WsRoomLivingType,
  WsStartLiveType,
  WsUpdateJoinInfoType,
} from '@/interface-ws';
import { WebRTCClass } from '@/network/webRTC';
import { WebSocketClass, prettierReceiveWsMsg } from '@/network/webSocket';
import { useAppStore } from '@/store/app';
import { useNetworkStore } from '@/store/network';
import { useUserStore } from '@/store/user';
import { createVideo, formatDownTime } from '@/utils';

import { useRTCParams } from './use-rtcParams';

export const useSrsWs = () => {
  const appStore = useAppStore();
  const userStore = useUserStore();
  const networkStore = useNetworkStore();
  const { maxBitrate, maxFramerate, resolutionRatio } = useRTCParams();

  const loopHeartbeatTimer = ref();
  const liveUserList = ref<ILiveUser[]>([]);
  const roomId = ref('');
  const isPull = ref(false);
  const roomLiving = ref(false);
  const isAnchor = ref(false);
  const isSRS = ref(false);
  const anchorInfo = ref<IUser>();
  const anchorSocketId = ref('');
  const canvasVideoStream = ref<MediaStream>();
  const lastCoverImg = ref('');
  const currentMaxBitrate = ref(maxBitrate.value[3].value);
  const currentMaxFramerate = ref(maxFramerate.value[2].value);
  const currentResolutionRatio = ref(resolutionRatio.value[3].value);
  const timerObj = ref({});
  const damuList = ref<IDanmu[]>([]);

  onUnmounted(() => {
    clearInterval(loopHeartbeatTimer.value);
  });

  const mySocketId = computed(() => {
    return networkStore.wsMap.get(roomId.value)?.socketIo?.id || '-1';
  });

  function handleHeartbeat(socketId: string) {
    loopHeartbeatTimer.value = setInterval(() => {
      const ws = networkStore.wsMap.get(roomId.value);
      if (!ws) return;
      ws.send<WsHeartbeatType['data']>({
        requestId: getRandomString(8),
        msgType: WsMsgTypeEnum.heartbeat,
        data: {
          socket_id: socketId,
        },
      });
    }, 1000 * 5);
  }

  async function handleSendOffer({ receiver }: { receiver: string }) {
    console.log('开始handleSendOffer');
    const ws = networkStore.wsMap.get(roomId.value);
    if (!ws) return;
    const rtc = networkStore.getRtcMap(`${roomId.value}___${receiver}`);
    if (!rtc) return;
    canvasVideoStream.value?.getTracks().forEach((track) => {
      if (rtc && canvasVideoStream.value) {
        console.log('11canvasVideoStream插入track', track.kind, track);
        rtc.peerConnection?.addTrack(track, canvasVideoStream.value);
      }
    });
    const sdp = await rtc.createOffer();
    await rtc.setLocalDescription(sdp!);
    const myLiveRoom = userStore.userInfo!.live_rooms![0];
    const res = await fetchRtcV1Publish({
      api: `/rtc/v1/publish/`,
      clientip: null,
      sdp: sdp!.sdp!,
      streamurl: `${myLiveRoom.rtmp_url!}?${
        SRS_CB_URL_PARAMS.publishKey
      }=${myLiveRoom.key!}&${SRS_CB_URL_PARAMS.publishType}=${
        LiveRoomTypeEnum.user_srs
      }`,
      tid: getRandomString(10),
    });
    networkStore.wsMap.get(roomId.value)?.send<WsUpdateJoinInfoType['data']>({
      requestId: getRandomString(8),
      msgType: WsMsgTypeEnum.updateJoinInfo,
      data: {
        live_room_id: Number(roomId.value),
        track: {
          audio: 1,
          video: 1,
        },
      },
    });
    if (res.data.code !== 0) {
      console.error('/rtc/v1/publish/拿不到sdp');
      window.$message.error('/rtc/v1/publish/拿不到sdp');
      return;
    }
    await rtc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: res.data.sdp })
    );
  }

  function handleStartLive({
    coverImg,
    name,
    type,
    receiver,
    chunkDelay,
  }: {
    coverImg?: string;
    name?: string;
    type: LiveRoomTypeEnum;
    receiver: string;
    videoEl?: HTMLVideoElement;
    chunkDelay: number;
  }) {
    console.log('handleStartLivehandleStartLive', receiver);
    networkStore.wsMap.get(roomId.value)?.send<WsStartLiveType['data']>({
      requestId: getRandomString(8),
      msgType: WsMsgTypeEnum.startLive,
      data: {
        cover_img: coverImg!,
        name: name!,
        type,
        chunkDelay,
      },
    });
    if (type === LiveRoomTypeEnum.user_msr) {
      return;
    }
    if (type !== LiveRoomTypeEnum.user_wertc) {
      startNewWebRtc({
        videoEl: createVideo({}),
        receiver,
      });
    }
  }

  function sendJoin() {
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance) return;
    instance.send<WsJoinType['data']>({
      requestId: getRandomString(8),
      msgType: WsMsgTypeEnum.join,
      data: {
        socket_id: mySocketId.value,
        live_room: {
          id: Number(roomId.value),
        },
        user_info: userStore.userInfo,
      },
    });
  }

  /** 原生的webrtc时，receiver必传 */
  function startNewWebRtc({
    receiver,
    videoEl,
  }: {
    receiver: string;
    videoEl: HTMLVideoElement;
  }) {
    console.warn(
      '22开始new WebRTCClass',
      receiver,
      `${roomId.value}___${receiver!}`,
      isSRS.value,
      canvasVideoStream.value
    );
    new WebRTCClass({
      maxBitrate: currentMaxBitrate.value,
      maxFramerate: currentMaxFramerate.value,
      resolutionRatio: currentResolutionRatio.value,
      roomId: `${roomId.value}___${receiver!}`,
      videoEl,
      isSRS: true,
      receiver,
      localStream: canvasVideoStream.value,
    });
    isSRS.value = true;
    handleSendOffer({
      receiver,
    });
  }

  function initReceive() {
    const ws = networkStore.wsMap.get(roomId.value);
    if (!ws?.socketIo) return;
    // websocket连接成功
    ws.socketIo.on(WsConnectStatusEnum.connect, () => {
      prettierReceiveWsMsg(WsConnectStatusEnum.connect, ws.socketIo);
      handleHeartbeat(ws.socketIo!.id);
      if (!ws) return;
      ws.status = WsConnectStatusEnum.connect;
      ws.update();
      sendJoin();
    });

    // websocket连接断开
    ws.socketIo.on(WsConnectStatusEnum.disconnect, (err) => {
      prettierReceiveWsMsg(WsConnectStatusEnum.disconnect, ws);
      console.log('websocket连接断开', err);
      if (!ws) return;
      ws.status = WsConnectStatusEnum.disconnect;
      ws.update();
    });

    // 收到offer
    ws.socketIo.on(WsMsgTypeEnum.offer, async (data: WsOfferType['data']) => {
      console.log('收到offer', data);
      if (data.receiver === mySocketId.value) {
        console.warn('是发给我的offer');
        console.warn(
          '33开始new WebRTCClass',
          `${roomId.value}___${data.sender}`
        );
        const videoEl = createVideo({ appendChild: true });
        const rtc = new WebRTCClass({
          maxBitrate: currentMaxBitrate.value,
          maxFramerate: currentMaxFramerate.value,
          resolutionRatio: currentResolutionRatio.value,
          roomId: `${roomId.value}___${data.sender}`,
          videoEl,
          isSRS: true,
          receiver: data.receiver,
        });
        isSRS.value = true;
        await rtc.setRemoteDescription(data.sdp);
        const answer = await rtc.createAnswer();
        if (answer) {
          await rtc.setLocalDescription(answer);
          ws.send<WsAnswerType['data']>({
            requestId: getRandomString(8),
            msgType: WsMsgTypeEnum.answer,
            data: {
              live_room_id: Number(roomId.value),
              sdp: answer,
              receiver: data.sender,
              sender: mySocketId.value,
            },
          });
        } else {
          console.error('没有answer');
        }
      } else {
        console.error('不是发给我的offer');
      }
    });

    // 收到answer
    ws.socketIo.on(WsMsgTypeEnum.answer, (data: WsAnswerType['data']) => {
      console.log('收到answer', data);
      if (data.receiver === mySocketId.value) {
        console.warn('是发给我的answer', `${roomId.value}___${data.receiver}`);
        const rtc = networkStore.getRtcMap(`${roomId.value}___${data.sender}`)!;
        rtc.setRemoteDescription(data.sdp);
      } else {
        console.error('不是发给我的answer');
      }
    });

    // 收到candidate
    ws.socketIo.on(WsMsgTypeEnum.candidate, (data: WsCandidateType['data']) => {
      console.log('收到candidate', data);
      if (data.receiver === mySocketId.value) {
        console.warn('是发给我的candidate');
        const rtc = networkStore.getRtcMap(`${roomId.value}___${data.sender}`)!;
        rtc.addIceCandidate(data.candidate);
      } else {
        console.error('不是发给我的candidate');
      }
    });

    // 主播正在直播
    ws.socketIo.on(
      WsMsgTypeEnum.roomLiving,
      (data: WsRoomLivingType['data']) => {
        prettierReceiveWsMsg(WsMsgTypeEnum.roomLiving, data);
        roomLiving.value = true;
        if (data.anchor_socket_id) {
          anchorSocketId.value = data.anchor_socket_id;
        }
      }
    );

    // 主播不在直播
    ws.socketIo.on(WsMsgTypeEnum.roomNoLive, (data) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.roomNoLive, data);
      roomLiving.value = false;
    });

    // 当前所有在线用户
    ws.socketIo.on(
      WsMsgTypeEnum.liveUser,
      (data: WSGetRoomAllUserType['data']) => {
        console.log('当前所有在线用户当前所有在线用户', data.liveUser.length);
        prettierReceiveWsMsg(WsMsgTypeEnum.liveUser, data);
        liveUserList.value = data.liveUser;
      }
    );

    // 收到用户发送消息
    ws.socketIo.on(WsMsgTypeEnum.message, (data: WsMessageType) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.message, data);
      damuList.value.push({
        request_id: data.request_id,
        socket_id: data.socket_id,
        msgType: DanmuMsgTypeEnum.danmu,
        msg: data.data.msg,
        userInfo: data.user_info,
        msgIsFile: data.data.msgIsFile,
        sendMsgTime: data.data.sendMsgTime,
      });
    });

    // 收到disableSpeaking
    ws.socketIo.on(
      WsMsgTypeEnum.disableSpeaking,
      (data: WsDisableSpeakingType['data']) => {
        prettierReceiveWsMsg(WsMsgTypeEnum.disableSpeaking, data);
        if (data.is_disable_speaking) {
          window.$message.error('你已被禁言！');
          appStore.disableSpeaking.set(data.live_room_id, {
            exp: data.disable_expired_at,
            label: formatDownTime({
              startTime: +new Date(),
              endTime: data.disable_expired_at,
            }),
          });
          clearTimeout(timerObj.value[data.live_room_id]);
          timerObj.value[data.live_room_id] = setInterval(() => {
            if (
              data.disable_expired_at &&
              +new Date() > data.disable_expired_at
            ) {
              clearTimeout(timerObj.value[data.live_room_id]);
            }
            appStore.disableSpeaking.set(data.live_room_id, {
              exp: data.disable_expired_at!,
              label: formatDownTime({
                startTime: +new Date(),
                endTime: data.disable_expired_at!,
              }),
            });
          }, 1000);
          damuList.value = damuList.value.filter(
            (v) => v.request_id !== data.request_id
          );
        }
        if (data.user_id !== userStore.userInfo?.id && data.disable_ok) {
          window.$message.success('禁言成功！');
        }
        if (
          data.user_id !== userStore.userInfo?.id &&
          data.restore_disable_ok
        ) {
          window.$message.success('解除禁言成功！');
        }
        if (
          data.user_id === userStore.userInfo?.id &&
          data.restore_disable_ok
        ) {
          window.$message.success('禁言接触了！');
          clearTimeout(timerObj.value[data.live_room_id]);
          appStore.disableSpeaking.delete(data.live_room_id);
        }
      }
    );

    // 用户加入房间完成
    ws.socketIo.on(WsMsgTypeEnum.joined, (data: WsJoinType['data']) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.joined, data);
      // liveUserList.value.push({
      //   id: data.socket_id,
      //   userInfo: data.user_info,
      // });
      appStore.setLiveRoomInfo(data.live_room);
      anchorInfo.value = data.anchor_info;
      ws.send<WsGetLiveUserType['data']>({
        requestId: getRandomString(8),
        msgType: WsMsgTypeEnum.getLiveUser,
        data: {
          live_room_id: data.live_room.id!,
        },
      });
    });

    // 其他用户加入房间
    ws.socketIo.on(WsMsgTypeEnum.otherJoin, (data: WsOtherJoinType['data']) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.otherJoin, data);
      // liveUserList.value.push({
      //   id: data.join_socket_id,
      //   userInfo: data.join_user_info,
      // });
      const requestId = getRandomString(8);
      const danmu: IDanmu = {
        request_id: requestId,
        msgType: DanmuMsgTypeEnum.otherJoin,
        socket_id: data.join_socket_id,
        userInfo: data.join_user_info,
        msgIsFile: false,
        msg: '',
        sendMsgTime: +new Date(),
      };
      damuList.value.push(danmu);
      ws.send<WsGetLiveUserType['data']>({
        requestId,
        msgType: WsMsgTypeEnum.getLiveUser,
        data: {
          live_room_id: data.live_room.id!,
        },
      });
      if (!isPull.value && !isSRS.value) {
        if (!roomLiving.value) return;
        // liveUserList.value.forEach(async (item) => {
        //   const receiver = item.id;
        //   if (
        //     receiver === mySocketId.value ||
        //     networkStore.getRtcMap(`${roomId.value}___${receiver!}`)
        //   )
        //     return;
        //   console.warn(
        //     '11开始new WebRTCClass',
        //     `${roomId.value}___${receiver!}`
        //   );
        //   const rtc = new WebRTCClass({
        //     maxBitrate: currentMaxBitrate.value,
        //     maxFramerate: currentMaxFramerate.value,
        //     resolutionRatio: currentResolutionRatio.value,
        //     roomId: `${roomId.value}___${receiver!}`,
        //     videoEl: createVideo({}),
        //     isSRS: false,
        //     receiver,
        //   });
        //   networkStore.updateRtcMap(`${roomId.value}___${receiver!}`, rtc);
        //   canvasVideoStream.value?.getTracks().forEach((track) => {
        //     if (rtc && canvasVideoStream.value) {
        //       console.log('22canvasVideoStream插入track', track.kind, track);
        //       rtc.peerConnection?.addTrack(track, canvasVideoStream.value);
        //     }
        //   });
        //   const ws = networkStore.wsMap.get(roomId.value)!;
        //   const offer = await rtc.createOffer();
        //   await rtc.setLocalDescription(offer!);
        //   ws.send<WsOfferType['data']>({
        //     msgType: WsMsgTypeEnum.offer,
        //     data: {
        //       sdp: offer,
        //       live_room_id: Number(roomId.value),
        //       sender: mySocketId.value,
        //       receiver,
        //     },
        //   });
        // });
      }
    });

    // 用户离开房间
    ws.socketIo.on(WsMsgTypeEnum.leave, (data) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.leave, data);
    });

    // 用户离开房间完成
    ws.socketIo.on(WsMsgTypeEnum.leaved, (data: WsLeavedType['data']) => {
      prettierReceiveWsMsg(WsMsgTypeEnum.leaved, data);
      if (anchorSocketId.value === data.socket_id) {
        roomLiving.value = false;
      }
      networkStore.rtcMap
        .get(`${roomId.value}___${data.socket_id as string}`)
        ?.close();
      networkStore.removeRtc(`${roomId.value}___${data.socket_id as string}`);
      // const res = liveUserList.value.filter(
      //   (item) => item.id !== data.socket_id
      // );
      // liveUserList.value = res;
      damuList.value.push({
        socket_id: data.socket_id,
        msgType: DanmuMsgTypeEnum.userLeaved,
        msgIsFile: false,
        userInfo: data.user_info,
        msg: '',
      });
    });
  }

  function initSrsWs(data: {
    isAnchor: boolean;
    roomId: string;
    currentResolutionRatio?: number;
    currentMaxFramerate?: number;
    currentMaxBitrate?: number;
  }) {
    roomId.value = data.roomId;
    isAnchor.value = data.isAnchor;
    if (data.currentMaxBitrate) {
      currentMaxBitrate.value = data.currentMaxBitrate;
    }
    if (data.currentMaxFramerate) {
      currentMaxFramerate.value = data.currentMaxFramerate;
    }
    if (data.currentResolutionRatio) {
      currentResolutionRatio.value = data.currentResolutionRatio;
    }
    new WebSocketClass({
      roomId: roomId.value,
      url: WEBSOCKET_URL,
      isAnchor: data.isAnchor,
    });
    initReceive();
  }

  return {
    isPull,
    initSrsWs,
    handleStartLive,
    mySocketId,
    canvasVideoStream,
    lastCoverImg,
    roomLiving,
    anchorInfo,
    liveUserList,
    damuList,
    currentMaxFramerate,
    currentMaxBitrate,
    currentResolutionRatio,
  };
};
