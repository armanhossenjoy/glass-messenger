import React, { useState, useEffect, useRef } from 'react';
import { Send, User, MessageSquare, Phone, Video, Image as ImageIcon, LogOut, Copy, Check, X, Camera, ArrowLeft, UserPlus, Search } from 'lucide-react';
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
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [syncStatus, setSyncStatus] = useState('connecting'); // 'online', 'connecting', 'error'
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [isCalling, setIsCalling] = useState(false);
  const [callType, setCallType] = useState(null); // 'audio' or 'video'

  const messagesEndRef = useRef(null);
  const activeFriendRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
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
      .channel(`sync-all-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        const currentActiveFriend = activeFriendRef.current;
        console.log("☁️ Syncing Message:", msg);

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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friends', filter: `user_id=eq.${userId}` }, () => {
        fetchFriends(userId);
      })
      .subscribe((status) => {
        console.log("SYNC STATUS:", status);
        if (status === 'SUBSCRIBED') setSyncStatus('online');
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
    if (remoteStream && remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (activeFriend && user) {
      fetchMessages(activeFriend.friend_id);
    }
  }, [activeFriend, user]);

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
    const { error } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        username: displayName,
        avatar_url: bio,
        updated_at: new Date()
      });

    if (!error) {
      setShowProfile(false);
      alert("Profile updated!");
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

    setCallType(type);
    setIsCalling(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: type === 'video',
        audio: true
      });
      setLocalStream(stream);

      const outgoingCall = peer.call(activeFriend.friend_id, stream, { metadata: { type } });
      setCall(outgoingCall);

      outgoingCall.on('stream', (remote) => {
        setRemoteStream(remote);
      });

      outgoingCall.on('close', () => endCall());
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
        audio: true
      });
      setLocalStream(stream);
      incomingCall.answer(stream);
      setCall(incomingCall);

      incomingCall.on('stream', (remote) => {
        setRemoteStream(remote);
      });

      incomingCall.on('close', () => endCall());
      setIncomingCall(null);
    } catch (err) {
      console.error("Accept failed:", err);
      alert("Could not access camera/mic.");
      endCall();
    }
  };

  const endCall = () => {
    if (call) call.close();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    setCall(null);
    setIncomingCall(null);
    setLocalStream(null);
    setRemoteStream(null);
    setIsCalling(false);
    setCallType(null);
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

  if (!user) {
    return (
      <div className="glass-card" style={{ padding: '50px 40px', width: '90%', maxWidth: '420px', textAlign: 'center', animation: 'slideUp 0.6s ease-out' }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ background: 'linear-gradient(135deg, var(--primary-accent), var(--secondary-accent))', width: '90px', height: '90px', borderRadius: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', boxShadow: '0 15px 30px rgba(99, 102, 241, 0.3)', transform: 'rotate(-5deg)' }}>
            <MessageSquare size={45} color="white" />
          </div>
          <h1 style={{ fontSize: '32px', fontWeight: '800', margin: '0 0 10px', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Glass Messenger</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '16px' }}>Elegant, private, real-time messaging.</p>
        </div>
        <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {!isLogin && (
            <input className="glass-input" type="text" placeholder="Full Name" value={signupName} onChange={e => setSignupName(e.target.value)} required />
          )}
          <input className="glass-input" type="email" placeholder="Email Address" value={email} onChange={e => setEmail(e.target.value)} required />
          <input className="glass-input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
          <button className="glass-button" type="submit" style={{ fontSize: '16px', padding: '16px' }}>
            {isLogin ? 'Login' : 'Create Account'}
          </button>
        </form>
        <p style={{ marginTop: '24px', fontSize: '15px', color: 'var(--text-secondary)' }}>
          {isLogin ? "New here? " : "Already have an account? "}
          <span style={{ cursor: 'pointer', color: 'var(--primary-accent)', fontWeight: '700' }} onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? 'Create one' : 'Sign in'}
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* SIDEBAR: FRIEND LIST */}
      <aside className={`sidebar glass-card ${view === 'list' ? 'active' : ''}`}>
        {/* Sidebar Header */}
        <div style={{ padding: '24px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer' }} onClick={() => setShowProfile(true)}>
            <div style={{ width: '48px', height: '48px', borderRadius: '16px', background: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--glass-border)' }}>
              <User size={24} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>{displayName || 'Setting up...'}</h3>
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
              onClick={() => { setActiveFriend(f); setView('chat'); }}
            >
              <div style={{ width: '50px', height: '50px', borderRadius: '18px', background: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', border: '1px solid var(--glass-border)' }}>
                {f.friend_username?.[0]?.toUpperCase() || 'U'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: '700', fontSize: '16px', marginBottom: '2px' }}>{f.friend_username}</div>
                <div style={{ fontSize: '13px', color: 'var(--success-accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--success-accent)' }}></div> Active Now
                </div>
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
                  <span style={{ fontSize: '11px', color: 'var(--success-accent)', fontWeight: '600' }}>Online</span>
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
                  <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '6px', textAlign: 'right' }}>
                    {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                  <div style={{ width: '140px', height: '140px', borderRadius: '50px', background: 'rgba(255,255,255,0.05)', margin: '0 auto 30px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <User size={80} />
                  </div>
                  <h2 style={{ fontSize: '28px', fontWeight: '800' }}>{activeFriend?.friend_username}</h2>
                  <p style={{ opacity: 0.6 }}>Voice Connection Active</p>
                </div>
              )}
            </div>
            <div style={{ padding: '60px', background: 'linear-gradient(transparent, rgba(0,0,0,0.4))', display: 'flex', justifyContent: 'center' }}>
              <button className="glass-button" style={{ width: '70px', height: '70px', borderRadius: '35px', background: 'var(--error-accent)', border: 'none', padding: 0 }} onClick={endCall}>
                <X size={32} />
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfile && (
        <div className="modal-overlay" onClick={() => setShowProfile(false)}>
          <div className="glass-card" style={{ width: '100%', maxWidth: '420px', padding: '40px', position: 'relative', animation: 'slideUp 0.4s ease' }} onClick={e => e.stopPropagation()}>
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
                <input className="glass-input" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="How friends see you" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', marginBottom: '8px', opacity: 0.6, textTransform: 'uppercase' }}>About / Bio</label>
                <input className="glass-input" value={bio} onChange={e => setBio(e.target.value)} placeholder="Something about you..." />
              </div>
              <button className="glass-button" style={{ background: 'var(--primary-accent)', border: 'none', marginTop: '10px' }} onClick={handleUpdateProfile}>Save Changes</button>

              <div style={{ width: '100%', height: '1px', background: 'var(--glass-border)', margin: '10px 0' }}></div>

              <button className="glass-button" style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'var(--error-accent)', border: 'none', justifyContent: 'center' }} onClick={() => supabase.auth.signOut()}>
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
