import React, { useState, useEffect, useRef } from 'react';
import { Send, User, MessageSquare, Phone, Video, Image as ImageIcon, LogOut, Copy, Check, X, Camera, ArrowLeft, UserPlus, Search, Volume2 } from 'lucide-react';
import { supabase } from './supabaseClient';
import Peer from 'peerjs';

function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupName, setSignupName] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [messages, setMessages] = useState([]);
  const [friends, setFriends] = useState([]);
  const [inputText, setInputText] = useState('');
  const [peer, setPeer] = useState(null);
  const [myPeerId, setMyPeerId] = useState('');
  const [friendInput, setFriendInput] = useState('');
  const [activeFriend, setActiveFriend] = useState(null); // The friend we are currently chatting with
  const [view, setView] = useState('list'); // 'list' or 'chat'
  const [copied, setCopied] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [displayName, setDisplayName] = useState(''); // This is the UNIQUE USERNAME (ID)
  const [fullName, setFullName] = useState(''); // This is the VISIBLE NAME
  const [bio, setBio] = useState('');
  const [syncStatus, setSyncStatus] = useState('connecting'); // 'online', 'connecting', 'error'
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [isCalling, setIsCalling] = useState(false);
  const [callType, setCallType] = useState(null); // 'audio' or 'video'
  const [callDuration, setCallDuration] = useState(0);
  const [unreadCounts, setUnreadCounts] = useState({}); // { friendId: count }
  const [isCallConnected, setIsCallConnected] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState([]); // Array of peer IDs (user IDs) who are online
  const [callState, setCallState] = useState('idle'); // 'idle' | 'calling' | 'ringing' | 'connected' | 'declined'

  // Timer Logic
  useEffect(() => {
    let interval;
    if (isCalling && isCallConnected) {
      interval = setInterval(() => setCallDuration(prev => prev + 1), 1000);
      document.title = `Call (${Math.floor(callDuration / 60)}:${(callDuration % 60).toString().padStart(2, '0')}) - PMFP`;
    } else {
      setCallDuration(0);
      document.title = "PMFP";
    }
    return () => clearInterval(interval);
  }, [isCalling, isCallConnected, callDuration]);

  const formatTime = (secs) => `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;

  const messagesEndRef = useRef(null);
  const activeFriendRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const ringtoneRef = useRef(null);
  const notificationSoundRef = useRef(null);
  // Ref to avoid stale closure in listeners

  // Update ref whenever activeFriend changes
  useEffect(() => {
    activeFriendRef.current = activeFriend;
  }, [activeFriend]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id, session.user.email);
        fetchFriends(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id, session.user.email);
        fetchFriends(session.user.id);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Dedicated effect for Realtime Sync
  useEffect(() => {
    if (!user) return;

    const channel = setupRealtime(user.id);

    return () => {
      if (channel) {
        console.log("Cleaning up Channel:", channel.topic);
        supabase.removeChannel(channel);
      }
    };
  }, [user?.id]);

  const setupRealtime = (userId) => {
    console.log("Initialising Sync Engine...");
    setSyncStatus('connecting');

    const channel = supabase
      .channel(`sync-all-${userId}`, {
        config: {
          presence: {
            key: userId,
          },
        },
      })
      .on('presence', { event: 'sync' }, () => {
        const newState = channel.presenceState();
        const onlineIds = Object.keys(newState);
        console.log("🟢 Online Users Sync:", onlineIds);
        setOnlineUserIds(onlineIds);
      })
      .on('presence', { event: 'join', key: userId }, ({ newPresences }) => {
        console.log('User joined:', newPresences);
      })
      .on('presence', { event: 'leave', key: userId }, ({ leftPresences }) => {
        console.log('User left:', leftPresences);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        const currentActiveFriend = activeFriendRef.current;
        console.log("☁️ Syncing Message:", msg);

        // Sound and Unread Logic
        if (msg.recipient_id === userId) {
          playNotificationSound();
          if (!currentActiveFriend || msg.sender_id !== currentActiveFriend.friend_id) {
            setUnreadCounts(prev => ({
              ...prev,
              [msg.sender_id]: (prev[msg.sender_id] || 0) + 1
            }));
          } else {
            // Already in chat, mark as read immediately
            markMessagesAsRead(msg.sender_id);
          }
        }

        if (currentActiveFriend && (
          (msg.sender_id === userId && msg.recipient_id === currentActiveFriend.friend_id) ||
          (msg.sender_id === currentActiveFriend.friend_id && msg.recipient_id === userId)
        )) {
          setMessages(prev => {
            // Check if we have an optimistic version of this message
            const existingIndex = prev.findIndex(m =>
              m.id === msg.id ||
              (m.text === msg.text && m.sender_id === msg.sender_id && m.tempId)
            );

            if (existingIndex !== -1) {
              const newMessages = [...prev];
              newMessages[existingIndex] = msg; // Swap optimistic for real
              return newMessages;
            }
            return [...prev, msg];
          });
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const updatedMsg = payload.new;
        const currentActiveFriend = activeFriendRef.current;

        // Update unread messages list if they correspond to the active friend
        if (currentActiveFriend && (
          (updatedMsg.sender_id === userId && updatedMsg.recipient_id === currentActiveFriend.friend_id) ||
          (updatedMsg.sender_id === currentActiveFriend.friend_id && updatedMsg.recipient_id === userId)
        )) {
          setMessages(prev => prev.map(m => m.id === updatedMsg.id ? updatedMsg : m));
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friends', filter: `user_id=eq.${userId}` }, () => {
        fetchFriends(userId);
      })
      .subscribe(async (status) => {
        console.log("SYNC STATUS:", status);
        if (status === 'SUBSCRIBED') {
          setSyncStatus('online');
          await channel.track({ online_at: new Date().toISOString() });
        }
        else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') setSyncStatus('error');
      });

    return channel;
  };

  useEffect(() => {
    if (user) {
      // Use User UUID as Peer ID for reliable calls
      const newPeer = new Peer(user.id);

      newPeer.on('open', (id) => {
        setMyPeerId(id);
        console.log("PeerJS Open with ID:", id);
      });

      // Handle Data (Messages)
      newPeer.on('connection', (conn) => {
        conn.on('data', (data) => {
          if (activeFriendRef.current && data.sender_id === activeFriendRef.current.friend_id) {
            setMessages(prev => [...prev, data]);
          }
        });
      });

      // Handle Calls (Audio/Video)
      newPeer.on('call', (incoming) => {
        console.log("Incoming call from:", incoming.peer);
        setIncomingCall(incoming);
        setCallType(incoming.metadata?.type || 'video');
      });

      setPeer(newPeer);
      return () => newPeer.destroy();
    }
  }, [user]);

  // Video Stream Side-Effects
  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      console.log("Attaching remote stream to:", remoteVideoRef.current.tagName);
      console.log("Remote Tracks:", remoteStream.getAudioTracks());
      remoteVideoRef.current.srcObject = remoteStream;

      // Force play to bypass some browser autoplay policies
      remoteVideoRef.current.play().catch(err => {
        console.error("Autoplay failed:", err);
        alert("Click the screen to enable audio! (Browser Policy)");
      });

      // --- WEB AUDIO API FALLBACK (Nuclear Option for Mobile) ---
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(remoteStream);
          source.connect(audioCtx.destination);

          // Resume context if suspended (common on mobile)
          if (audioCtx.state === 'suspended') {
            document.addEventListener('click', () => audioCtx.resume(), { once: true });
            document.addEventListener('touchstart', () => audioCtx.resume(), { once: true });
          }
          console.log("Web Audio API Initialized:", audioCtx.state);
        }
      } catch (e) {
        console.error("Web Audio API Failed:", e);
      }
    }
  }, [remoteStream, callType]);

  // Play ringtone when incoming call
  useEffect(() => {
    if (incomingCall && ringtoneRef.current) {
      ringtoneRef.current.play().catch(err => console.log("Ringtone blocked:", err));
    } else if (!incomingCall && ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current.currentTime = 0;
    }
  }, [incomingCall]);

  // Play notification on new message (helper) - Using Web Audio API
  const playNotificationSound = () => {
    console.log('🔔 Attempting to play notification sound...');
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);

      console.log('🔔 Notification sound played successfully');
    } catch (err) {
      console.warn("🔕 Notification sound failed:", err);
    }
  };

  useEffect(() => {
    if (activeFriend && user) {
      fetchMessages(activeFriend.friend_id);
      markMessagesAsRead(activeFriend.friend_id);
    }
  }, [activeFriend, user]);

  const markMessagesAsRead = async (friendId) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from('messages')
        .update({ is_read: true })
        .eq('recipient_id', user.id)
        .eq('sender_id', friendId)
        .eq('is_read', false);

      if (error) {
        // If the column doesn't exist, we'll get an error. 
        // We log it but don't break the app.
        console.warn("Read receipts might not be supported yet (is_read column missing?)", error);
      }
    } catch (err) {
      console.error("Failed to mark messages as read:", err);
    }
  };

  const fetchProfile = async (userId, userEmail) => {
    let { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      const baseName = userEmail ? userEmail.split('@')[0] : 'user';
      const customUsername = `${baseName.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.floor(1000 + Math.random() * 9000)}`;

      const { data: newProfile } = await supabase
        .from('profiles')
        .upsert({
          id: userId,
          username: customUsername,
          full_name: baseName,
          updated_at: new Date()
        })
        .select()
        .single();

      if (newProfile) data = newProfile;
    }

    if (data) {
      setDisplayName(data.username || '');
      setFullName(data.full_name || '');
      setBio(data.avatar_url || '');
    }
  };

  const fetchFriends = async (userId) => {
    console.log("Fetching friends for UUID:", userId);
    const { data, error } = await supabase
      .from('friends')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error("Friend fetch error:", error);
    } else {
      console.log("Friend list loaded:", data);
      setFriends(data || []);
    }
  };

  const handleAddFriend = async () => {
    if (!friendInput.trim()) return;
    console.log("Attempting to add friend:", friendInput);

    try {
      // 1. Find the friend's profile
      const { data: friendProfile, error: fError } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('username', friendInput)
        .single();

      if (fError || !friendProfile) {
        alert("Could not find user: " + friendInput);
        return;
      }

      if (friendProfile.id === user.id) {
        alert("You cannot add yourself!");
        return;
      }

      // 2. Find MY profile
      const { data: myProfile, error: mError } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', user.id)
        .single();

      if (mError || !myProfile) {
        alert("Your profile is missing. Try 'Save Profile' in your settings first.");
        return;
      }

      // 3. Insert MUTUAL rows
      const { error: insertError } = await supabase.from('friends').insert([
        { user_id: user.id, friend_id: friendProfile.id, friend_username: friendProfile.username },
        { user_id: friendProfile.id, friend_id: user.id, friend_username: myProfile.username }
      ]);

      if (insertError) {
        if (insertError.code === '23505') alert("This user is already in your list!");
        else throw insertError;
      } else {
        fetchFriends(user.id);
        setFriendInput('');
        alert("Friend added! They will also see you in their list now.");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  const fetchMessages = async (friendUserId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${user.id},recipient_id.eq.${friendUserId}),and(sender_id.eq.${friendUserId},recipient_id.eq.${user.id})`)
      .order('created_at', { ascending: true });

    if (data) setMessages(data);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (inputText.trim() && user && activeFriend) {
      const textToSend = inputText;
      setInputText('');

      const tempId = Date.now().toString();
      const newMessage = {
        tempId, // Marker for deduplication
        text: textToSend,
        sender_id: user.id,
        recipient_id: activeFriend.friend_id,
        created_at: new Date().toISOString(),
      };

      // 1. Show instantly
      setMessages(prev => [...prev, newMessage]);

      // 2. Save to cloud
      const { error } = await supabase.from('messages').insert([{
        text: newMessage.text,
        sender_id: newMessage.sender_id,
        recipient_id: newMessage.recipient_id
      }]);

      if (error) {
        alert("Sync Failed: " + error.message);
        setMessages(prev => prev.filter(m => m.tempId !== tempId));
      }
    }
  };

  const handleUpdateProfile = async () => {
    let finalUsername = displayName.trim();

    // 1. Ensure 4-digit suffix exists (Format: Name_1234)
    const suffixRegex = /_(\d{4})$/;
    if (!suffixRegex.test(finalUsername)) {
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      finalUsername = `${finalUsername}_${randomSuffix}`;
    }

    // 2. Check uniqueness (optional but good practice)
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', finalUsername)
      .neq('id', user.id)
      .single();

    if (existing) {
      // Collision detected, try new suffix
      const newSuffix = Math.floor(1000 + Math.random() * 9000);
      finalUsername = `${displayName.trim().replace(suffixRegex, '')}_${newSuffix}`;
    }

    const { error } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        username: finalUsername,
        full_name: fullName,
        avatar_url: bio,
        updated_at: new Date()
      });

    if (!error) {
      setDisplayName(finalUsername); // Update UI with the full ID
      setShowProfile(false);
      alert(`Profile updated! Your ID is: ${finalUsername}`);
    } else {
      alert("Error: " + error.message);
    }
  };

  // --- Calling Logic ---
  const startCall = async (type) => {
    if (!activeFriend) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Camera/Mic access is blocked. This usually happens on mobile if you are not using HTTPS. Check the walkthrough for the fix!");
      return;
    }

    setCallState('calling');
    setCallType(type);
    setIsCalling(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: type === 'video',
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          latency: 0
        }
      });
      setLocalStream(stream);

      const outgoingCall = peer.call(activeFriend.friend_id, stream, { metadata: { type, callerId: user.id } });
      setCall(outgoingCall);

      // When peer answers and we get their stream
      outgoingCall.on('stream', (remote) => {
        console.log('📞 Call connected! Stream received.');
        setRemoteStream(remote);
        setIsCallConnected(true);
        setCallState('connected');
      });

      // Detect when call object is established (ringing)
      outgoingCall.on('open', () => {
        console.log('📞 Call is ringing...');
        setCallState('ringing');
      });

      outgoingCall.on('close', () => {
        console.log('📞 Call closed by peer');
        if (callState !== 'connected') {
          setCallState('declined');
          setTimeout(() => endCall(), 2000);
        } else {
          endCall();
        }
      });
    } catch (err) {
      console.error("Call failed:", err);
      alert("Could not access camera/mic.");
      setIsCalling(false);
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Camera/Mic access is blocked. Cannot answer call.");
      endCall();
      return;
    }

    setIsCalling(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: callType === 'video',
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          latency: 0
        }
      });
      setLocalStream(stream);
      incomingCall.answer(stream);
      setCall(incomingCall);

      incomingCall.on('stream', (remote) => {
        console.log('📞 Call connected! Stream received.');
        setRemoteStream(remote);
        setIsCallConnected(true);
        setCallState('connected');
      });

      incomingCall.on('close', () => {
        console.log('📞 Call closed by peer');
        endCall();
      });
      setIncomingCall(null);
    } catch (err) {
      console.error("Accept failed:", err);
      alert("Could not access camera/mic.");
      endCall();
    }
  };

  const endCall = () => {
    console.log('📞 Ending call and resetting state');
    if (call) call.close();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    setCall(null);
    setIncomingCall(null);
    setLocalStream(null);
    setRemoteStream(null);
    setIsCalling(false);
    setCallType(null);
    setIsCallConnected(false);
    setCallState('idle');
  };

  const handleLogout = async () => {
    // 1. Clear Local State
    setMessages([]);
    setFriends([]);
    setUser(null);
    setDisplayName('');
    setFullName('');
    setBio('');

    // 2. Destroy Peer Connection
    if (peer) {
      peer.destroy();
      setPeer(null);
    }

    // 3. Sign Out from Supabase
    await supabase.auth.signOut();
    setIsLogin(true); // Return to Login Screen
    setShowProfile(false); // Close modal
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const customUsername = `${signupName.toLowerCase().replace(/\s+/g, '')}_${Math.floor(1000 + Math.random() * 9000)}`;
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { data: { full_name: signupName, username: customUsername } }
        });
        if (error) throw error;
        if (data.user) {
          await supabase.from('profiles').upsert({ id: data.user.id, username: customUsername, updated_at: new Date() });
        }
        alert('Check your email for verification link!');
      }
    } catch (error) {
      alert(error.message);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, view]);

  const handleGoogleLogin = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin
      }
    });
    if (error) alert("Google Login Failed: " + error.message);
  };

  if (!user) {
    return (
      <>
        {/* Hidden Audio Player for Ringtone */}
        <audio ref={ringtoneRef} loop>
          <source src="https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3" type="audio/mpeg" />
        </audio>
        <div className="glass-card" style={{ padding: '50px 40px', width: '90%', maxWidth: '420px', textAlign: 'center', animation: 'slideUp 0.6s ease-out' }}>
          <div style={{ marginBottom: '32px' }}>
            <div style={{ background: 'linear-gradient(135deg, var(--primary-accent), var(--secondary-accent))', width: '90px', height: '90px', borderRadius: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', boxShadow: '0 15px 30px rgba(99, 102, 241, 0.3)', transform: 'rotate(-5deg)' }}>
              <MessageSquare size={45} color="white" />
            </div>
            <h1 style={{ fontSize: '32px', fontWeight: '800', margin: '0 0 10px', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>PMFP</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '16px' }}>Elegant, private, real-time messaging.</p>
          </div>
          <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {!isLogin && (
              <input className="glass-input" type="text" placeholder="Full Name" value={signupName} onChange={e => setSignupName(e.target.value)} required />
            )}
            <input className="glass-input" type="email" placeholder="Email Address" value={email} onChange={e => setEmail(e.target.value)} required />
            <input className="glass-input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
            <button className="glass-button" type="submit" style={{ fontSize: '16px', padding: '14px', background: 'var(--primary-accent)' }}>
              {isLogin ? 'Login' : 'Create Account'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '20px 0', opacity: 0.5 }}>
            <div style={{ height: '1px', background: 'var(--glass-border)', flex: 1 }}></div>
            <span style={{ fontSize: '12px' }}>OR</span>
            <div style={{ height: '1px', background: 'var(--glass-border)', flex: 1 }}></div>
          </div>

          <button
            className="glass-button"
            onClick={handleGoogleLogin}
            style={{ width: '100%', padding: '14px', justifyContent: 'center', background: 'white', color: 'black', fontWeight: 'bold' }}
          >
            <svg style={{ width: '20px', height: '20px', marginRight: '10px' }} viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </button>

          <p style={{ marginTop: '24px', fontSize: '15px', color: 'var(--text-secondary)' }}>
            {isLogin ? "New here? " : "Already have an account? "}
            <span style={{ cursor: 'pointer', color: 'var(--primary-accent)', fontWeight: '700' }} onClick={() => setIsLogin(!isLogin)}>
              {isLogin ? 'Create one' : 'Sign in'}
            </span>
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="app-container">
      {/* Hidden Audio Player for Ringtone */}
      <audio ref={ringtoneRef} loop>
        <source src="https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3" type="audio/mpeg" />
      </audio>
      {/* SIDEBAR: FRIEND LIST */}
      <aside className={`sidebar glass-card ${view === 'list' ? 'active' : ''}`}>
        {/* Sidebar Header */}
        <div style={{ padding: '24px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer' }} onClick={() => setShowProfile(true)}>
            <div style={{ width: '48px', height: '48px', borderRadius: '16px', background: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--glass-border)' }}>
              <User size={24} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>{fullName || displayName || 'Setting up...'}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: syncStatus === 'online' ? 'var(--success-accent)' : syncStatus === 'connecting' ? '#facc15' : 'var(--error-accent)', boxShadow: `0 0 10px ${syncStatus === 'online' ? 'var(--success-accent)' : 'transparent'}` }}></div>
                <span style={{ fontSize: '11px', opacity: 0.6 }}>{syncStatus === 'online' ? 'Connected' : 'Syncing...'}</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="glass-button" style={{ padding: '10px', borderRadius: '12px' }} onClick={() => fetchFriends(user.id)} title="Refresh"><Search size={18} /></button>
          </div>
        </div>

        {/* Add Friend Section */}
        <div style={{ padding: '20px', borderBottom: '1px solid var(--glass-border)' }}>
          <div style={{ display: 'flex', gap: '10px', position: 'relative' }}>
            <input
              className="glass-input"
              placeholder="Friend ID (name_1234)"
              value={friendInput}
              onChange={e => setFriendInput(e.target.value)}
              style={{ flex: 1, paddingRight: '45px' }}
            />
            <button
              className="glass-button"
              style={{ position: 'absolute', right: '5px', top: '5px', bottom: '5px', width: '40px', padding: 0, borderRadius: '10px', background: 'transparent', border: 'none' }}
              onClick={handleAddFriend}
            >
              <UserPlus size={20} color="var(--primary-accent)" />
            </button>
          </div>
        </div>

        {/* Friends List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
          <p style={{ padding: '0 24px 12px', fontSize: '11px', fontWeight: '800', opacity: 0.4, textTransform: 'uppercase', letterSpacing: '2px' }}>Recent Chats</p>
          {friends.length === 0 && (
            <div style={{ padding: '60px 20px', textAlign: 'center', opacity: 0.3 }}>
              <MessageSquare size={48} style={{ margin: '0 auto 20px' }} />
              <p style={{ fontSize: '15px' }}>Your chat list is empty.<br />Add a friend to start!</p>
            </div>
          )}
          {friends.map((f, i) => (
            <div
              key={i}
              className={`friend-item ${activeFriend?.friend_id === f.friend_id ? 'active' : ''}`}
              onClick={() => {
                setActiveFriend(f);
                setView('chat');
                setUnreadCounts(prev => ({ ...prev, [f.friend_id]: 0 }));
                markMessagesAsRead(f.friend_id);
              }}
            >
              <div style={{ position: 'relative' }}>
                <div style={{ width: '50px', height: '50px', borderRadius: '18px', background: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', border: '1px solid var(--glass-border)' }}>
                  {f.friend_username?.[0]?.toUpperCase() || 'U'}
                </div>
                {unreadCounts[f.friend_id] > 0 && (
                  <div style={{ position: 'absolute', top: '-5px', right: '-5px', background: 'var(--error-accent)', color: 'white', fontSize: '10px', fontWeight: 'bold', minWidth: '18px', height: '18px', borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--bg-dark)', zIndex: 10 }}>
                    {unreadCounts[f.friend_id]}
                  </div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: '700', fontSize: '16px', marginBottom: '2px' }}>{f.friend_username}</div>
                {onlineUserIds.includes(f.friend_id) ? (
                  <div style={{ fontSize: '13px', color: 'var(--success-accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--success-accent)' }}></div> Active Now
                  </div>
                ) : (
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', opacity: 0.5 }}>Offline</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* MAIN VIEW: CHAT AREA */}
      <main className={`main-view glass-card ${view === 'chat' ? 'active' : ''}`}>
        {!activeFriend ? (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.4, padding: '40px', textAlign: 'center' }}>
            <div style={{ width: '120px', height: '120px', borderRadius: '40px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
              <MessageSquare size={60} />
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: '800', marginBottom: '10px' }}>Select a Conversation</h2>
            <p style={{ maxWidth: '300px', lineHeight: '1.6' }}>Choose a friend from the sidebar or add a new one to start messaging instantly.</p>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="chat-header" style={{ borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, paddingRight: '10px' }}>
                <button
                  className="glass-button mobile-only"
                  style={{ padding: '8px', borderRadius: '10px', flexShrink: 0 }}
                  onClick={() => setView('list')}
                >
                  <ArrowLeft size={18} />
                </button>
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, var(--primary-accent), var(--secondary-accent))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 'bold', flexShrink: 0 }}>
                  {activeFriend.friend_username?.[0]?.toUpperCase()}
                </div>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeFriend.friend_username}</h3>
                  {onlineUserIds.includes(activeFriend.friend_id) ? (
                    <span style={{ fontSize: '11px', color: 'var(--success-accent)', fontWeight: '600' }}>Online</span>
                  ) : (
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', opacity: 0.5 }}>Offline</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button className="glass-button" style={{ padding: '8px' }} onClick={() => startCall('audio')} title="Audio Call"><Phone size={18} /></button>
                <button className="glass-button" style={{ padding: '8px' }} onClick={() => startCall('video')} title="Video Call"><Video size={18} /></button>
              </div>
            </div>

            {/* Messages Area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {messages.map((m, i) => (
                <div key={i} className={`message-bubble animate-message ${m.sender_id === user.id ? 'message-sent' : 'message-received'}`}>
                  {m.text}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', gap: '8px' }}>
                    <div style={{ fontSize: '10px', opacity: 0.5 }}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {m.sender_id === user.id && (
                      <div style={{ fontSize: '10px', opacity: 0.8, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '2px' }}>
                        {m.is_read ? (
                          <><Check size={10} /> Seen</>
                        ) : (
                          <Check size={10} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <form onSubmit={handleSendMessage} className="chat-input-area">
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button type="button" className="glass-button" style={{ padding: '10px', borderRadius: '12px', flexShrink: 0 }}><ImageIcon size={20} /></button>
                <input
                  className="glass-input"
                  placeholder="Message..."
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  style={{ flex: 1, minWidth: 0, height: '44px' }}
                />
                <button type="submit" className="glass-button" style={{ width: '44px', height: '44px', padding: 0, borderRadius: '12px', background: 'var(--primary-accent)', flexShrink: 0 }}>
                  <Send size={20} />
                </button>
              </div>
            </form>
          </>
        )}
      </main>

      {/* MODALS */}
      {incomingCall && (
        <div className="modal-overlay">
          <div className="glass-card" style={{ width: '320px', padding: '40px', textAlign: 'center', animation: 'slideUp 0.4s ease' }}>
            <div style={{ width: '80px', height: '80px', borderRadius: '30px', background: 'rgba(255,255,255,0.1)', margin: '0 auto 24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {callType === 'video' ? <Video size={40} /> : <Phone size={40} />}
            </div>
            <h3 style={{ fontSize: '20px', fontWeight: '800' }}>Incoming {callType} Call</h3>
            <p style={{ opacity: 0.6, marginBottom: '32px' }}>Your friend is calling you...</p>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="glass-button" style={{ flex: 1, background: 'var(--error-accent)', border: 'none' }} onClick={() => { incomingCall.close(); setIncomingCall(null); }}>Decline</button>
              <button className="glass-button" style={{ flex: 1, background: 'var(--success-accent)', border: 'none' }} onClick={acceptCall}>Accept</button>
            </div>
          </div>
        </div>
      )}



      // ... (rest of render)

      {isCalling && (
        <div className="modal-overlay" style={{ background: 'rgba(15, 23, 42, 0.95)' }}>
          <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {callType === 'video' ? (
                <>
                  <video ref={remoteVideoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '120px', height: '180px', position: 'absolute', bottom: '120px', right: '30px', borderRadius: '20px', border: '2px solid rgba(255,255,255,0.2)', objectFit: 'cover' }} />
                </>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ width: '140px', height: '140px', borderRadius: '50px', background: 'rgba(255,255,255,0.05)', margin: '0 auto 30px', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 2s infinite' }}>
                    <User size={80} />
                  </div>
                  <h2 style={{ fontSize: '28px', fontWeight: '800', marginBottom: '10px' }}>{activeFriend?.friend_username}</h2>
                  {callState === 'calling' && (
                    <p style={{ fontSize: '16px', opacity: 0.7 }}>Calling...</p>
                  )}
                  {callState === 'ringing' && (
                    <p style={{ fontSize: '16px', opacity: 0.7 }}>Ringing...</p>
                  )}
                  {callState === 'connected' && (
                    <div style={{ fontSize: '24px', fontWeight: 'bold', fontFamily: 'monospace', opacity: 0.8, marginBottom: '20px' }}>
                      {formatTime(callDuration)}
                    </div>
                  )}
                  {callState === 'declined' && (
                    <p style={{ fontSize: '16px', color: 'var(--error-accent)' }}>Call Declined</p>
                  )}

                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginBottom: '10px', background: 'rgba(0,0,0,0.5)', padding: '5px', borderRadius: '5px' }}>
                    DEBUG:
                    Stream: {remoteStream ? 'Active' : 'No'} |
                    Tracks: {remoteStream?.getAudioTracks().length || 0} |
                    Muted: {remoteVideoRef.current?.muted ? 'Yes' : 'No'} |
                    Paused: {remoteVideoRef.current?.paused ? 'Yes' : 'No'}
                  </div>

                  {/* TRICK: Use VIDEO tag for audio to enforce Loudspeaker on Mobile (1px visible to prevent aggressive browser optimization) */}
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    style={{ width: '1px', height: '1px', opacity: 0.1, pointerEvents: 'none', position: 'absolute' }}
                  />
                </div>
              )}
            </div>
            <div style={{ padding: '60px', background: 'linear-gradient(transparent, rgba(0,0,0,0.4))', display: 'flex', justifyContent: 'center', gap: '20px' }}>
              <button className="glass-button" style={{ width: '60px', height: '60px', borderRadius: '30px', background: 'rgba(255,255,255,0.1)', border: 'none' }} onClick={() => {
                // Attempt to toggle speaker (experimental)
                if (remoteVideoRef.current && remoteVideoRef.current.setSinkId) {
                  // This is just a placeholder action as setSinkId needs device ID
                  alert("To switch to Speaker, please use your device's volume settings or control center.");
                } else {
                  alert("Please use your phone's Control Center to toggle Speaker/Earpiece.");
                }
              }} title="Speaker">
                <Volume2 size={24} />
              </button>

              <button className="glass-button" style={{ width: '70px', height: '70px', borderRadius: '35px', background: 'var(--error-accent)', border: 'none', padding: 0 }} onClick={endCall}>
                <X size={32} />
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfile && (
        <div className="modal-overlay" onClick={() => setShowProfile(false)} style={{ padding: '20px', overflowY: 'auto' }}>
          <div className="glass-card" style={{ width: '100%', maxWidth: '420px', padding: '40px', position: 'relative', animation: 'slideUp 0.4s ease', margin: 'auto', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <button style={{ position: 'absolute', top: '24px', right: '24px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', opacity: 0.5 }} onClick={() => setShowProfile(false)}>
              <X size={24} />
            </button>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <div style={{ width: '100px', height: '100px', borderRadius: '35px', background: 'linear-gradient(135deg, var(--primary-accent), var(--secondary-accent))', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <User size={50} color="white" />
                <div style={{ position: 'absolute', bottom: '-5px', right: '-5px', width: '32px', height: '32px', background: 'var(--bg-dark)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--glass-border)' }}>
                  <Camera size={16} />
                </div>
              </div>
              <h2 style={{ fontSize: '24px', fontWeight: '800', margin: 0 }}>My Profile</h2>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', marginBottom: '8px', opacity: 0.6, textTransform: 'uppercase' }}>Your Shareable ID</label>
              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '16px', border: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <code style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--primary-accent)' }}>{displayName}</code>
                <button style={{ background: 'none', border: 'none', color: 'var(--primary-accent)', cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(displayName); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                  {copied ? <Check size={20} /> : <Copy size={20} />}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', marginBottom: '8px', opacity: 0.6, textTransform: 'uppercase' }}>Display Name</label>
                <input className="glass-input" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your Name (e.g. Arman)" />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', marginBottom: '8px', opacity: 0.6, textTransform: 'uppercase' }}>User ID (Unique)</label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <input className="glass-input" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Unique ID (e.g. arman_1234)" />
                  <button className="glass-button" onClick={() => { navigator.clipboard.writeText(displayName); alert("ID Copied!") }} title="Copy ID"><Copy size={18} /></button>
                </div>
                <p style={{ fontSize: '11px', opacity: 0.5, marginTop: '5px' }}>*Use this ID to add friends.</p>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', marginBottom: '8px', opacity: 0.6, textTransform: 'uppercase' }}>About / Bio</label>
                <input className="glass-input" value={bio} onChange={e => setBio(e.target.value)} placeholder="Something about you..." />
              </div>
              <button className="glass-button" style={{ background: 'var(--primary-accent)', border: 'none', marginTop: '10px' }} onClick={handleUpdateProfile}>Save Changes</button>

              <div style={{ width: '100%', height: '1px', background: 'var(--glass-border)', margin: '10px 0' }}></div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="glass-button" style={{ flex: 1, fontSize: '12px' }} onClick={() => playNotificationSound()}>
                  <Volume2 size={16} /> Test Notification
                </button>
                <button className="glass-button" style={{ flex: 1, fontSize: '12px' }} onClick={() => {
                  if (ringtoneRef.current) {
                    ringtoneRef.current.play().then(() => {
                      setTimeout(() => {
                        ringtoneRef.current.pause();
                        ringtoneRef.current.currentTime = 0;
                      }, 2000);
                    });
                  }
                }}>
                  <Phone size={16} /> Test Ringtone
                </button>
              </div>

              <div style={{ width: '100%', height: '1px', background: 'var(--glass-border)', margin: '10px 0' }}></div>

              <button className="glass-button" style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'var(--error-accent)', border: 'none', justifyContent: 'center' }} onClick={handleLogout}>
                <LogOut size={18} /> Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
