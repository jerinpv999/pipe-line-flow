import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { getToken } from './api';

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocket(event, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    const fn = (data) => ref.current(data);
    s.on(event, fn);
    return () => s.off(event, fn);
  }, [event]);
}
