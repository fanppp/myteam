import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useDAGStore } from '../stores/dagStore';

function StartNodeComponent({ data }: { data: any }) {
  const [editText, setEditText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const taskStatus = useDAGStore((s) => s.taskStatus);
  const isDone = taskStatus === 'done' || taskStatus === 'error';
  const history: any[] = data.history || [];
  const onContinue = data.onContinue;
  const sessionId = data.sessionId;

  const handleContinue = () => {
    const msg = editText.trim() || (data.content as string);
    if (onContinue && sessionId && msg) {
      onContinue(msg, sessionId);
      setEditText('');
      setIsEditing(false);
    }
  };

  return (
    <div
      style={{
        width: '340px',
        overflow: 'hidden',
        border: '2px solid #a855f7',
        borderRadius: '10px',
        background: '#1e1e2e',
        color: '#cdd6f4',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      <div
        className="nodrag"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 14px',
          background: '#a855f718',
          borderBottom: '1px solid #a855f733',
          fontSize: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>📝</span>
          <strong>请求</strong>
          {sessionId && (
            <span style={{ fontSize: '10px', color: '#6c7086', marginLeft: '4px' }}>
              {sessionId.slice(0, 8)}
            </span>
          )}
        </div>
        {history.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              padding: '2px 8px',
              background: showHistory ? '#a855f733' : 'transparent',
              border: '1px solid #a855f744',
              borderRadius: '4px',
              color: '#a855f7',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {showHistory ? '◀ 收起' : `历史 (${history.length})`}
          </button>
        )}
      </div>

      {showHistory && history.length > 0 && (
        <div
          className="nodrag nowheel"
          style={{
            maxHeight: '200px',
            overflow: 'auto',
            borderBottom: '1px solid #313244',
            background: '#181825',
          }}
        >
          {history.map((h, i) => (
            <div
              key={i}
              style={{
                padding: '6px 14px',
                borderBottom: '1px solid #31324422',
                fontSize: '12px',
                color: '#7f849c',
                lineHeight: '1.4',
              }}
            >
              <span style={{
                fontSize: '10px',
                padding: '1px 5px',
                borderRadius: '3px',
                background: h.status === 'done' ? '#22c55e22' : h.status === 'error' ? '#ef444422' : '#3b82f622',
                color: h.status === 'done' ? '#22c55e' : h.status === 'error' ? '#ef4444' : '#3b82f6',
                marginRight: '6px',
              }}>{h.status}</span>
              {h.message.length > 80 ? h.message.slice(0, 80) + '...' : h.message}
            </div>
          ))}
        </div>
      )}

      <div
        className="nodrag nowheel"
        style={{
          padding: '10px 14px',
          fontSize: '13px',
          lineHeight: '1.5',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isEditing && isDone ? (
          <textarea
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleContinue();
            }}
            placeholder="输入续会话消息..."
            style={{
              width: '100%',
              minHeight: '60px',
              background: '#181825',
              border: '1px solid #a855f744',
              borderRadius: '6px',
              color: '#cdd6f4',
              fontSize: '13px',
              padding: '8px',
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <div
            onClick={() => {
              if (isDone) {
                setEditText(data.content || '');
                setIsEditing(true);
              }
            }}
            style={{
              cursor: isDone ? 'text' : 'default',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
            }}
          >
            {data.content || '(空)'}
          </div>
        )}
      </div>

      {isDone && onContinue && sessionId && (
        <div
          className="nodrag"
          style={{
            padding: '6px 14px',
            borderTop: '1px solid #313244',
            display: 'flex',
            gap: '8px',
            justifyContent: 'flex-end',
          }}
        >
          {isEditing ? (
            <>
              <button
                onClick={() => { setIsEditing(false); setEditText(''); }}
                style={{
                  padding: '4px 12px',
                  background: 'transparent',
                  border: '1px solid #45475a',
                  borderRadius: '6px',
                  color: '#7f849c',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >取消</button>
              <button
                onClick={handleContinue}
                style={{
                  padding: '4px 12px',
                  background: '#a855f7',
                  border: 'none',
                  borderRadius: '6px',
                  color: 'white',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >续会话 ▶</button>
            </>
          ) : (
            <button
              onClick={() => { setEditText(data.content || ''); setIsEditing(true); }}
              style={{
                padding: '4px 12px',
                background: '#a855f718',
                border: '1px solid #a855f744',
                borderRadius: '6px',
                color: '#a855f7',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >编辑并续会话</button>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: '#a855f7' }} />
    </div>
  );
}

export default memo(StartNodeComponent);
