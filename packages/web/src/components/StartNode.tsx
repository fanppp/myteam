import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useDAGStore } from '../stores/dagStore';

function StartNodeComponent({ data }: { data: any }) {
  const [input, setInput] = useState('');
  const [aborting, setAborting] = useState(false);
  const taskStatus = useDAGStore((s) => s.taskStatus);
  const taskId = useDAGStore((s) => s.taskId);
  const setTaskStatus = useDAGStore((s) => s.setTaskStatus);
  const syncNodeStatuses = useDAGStore((s) => s.syncNodeStatuses);

  const isRunning = taskStatus === 'running';
  const history: any[] = data.history || [];
  const onContinue = data.onContinue;
  const sessionId = data.sessionId;
  const teamId = data.teamId;

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || !onContinue || !sessionId) return;
    onContinue(msg, sessionId, teamId || '');
    setInput('');
  };

  const handleAbort = async () => {
    if (!taskId || aborting) return;
    setAborting(true);
    try {
      await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
      setTaskStatus('cancelled');
      syncNodeStatuses('cancelled');
    } catch {}
    setAborting(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
          <span style={{ fontSize: '10px', color: '#6c7086' }}>
            {history.length} 轮对话
          </span>
        )}
      </div>

      {history.length > 0 && (
        <div
          className="nodrag nowheel"
          style={{
            height: '150px',
            overflow: 'auto',
            borderBottom: '1px solid #313244',
            background: '#181825',
            userSelect: 'text',
            cursor: 'text',
          }}
          onMouseDown={(e) => e.stopPropagation()}
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
                background: h.status === 'done' ? '#22c55e22' : h.status === 'error' ? '#ef444422' : h.status === 'cancelled' ? '#f59e0b22' : '#3b82f622',
                color: h.status === 'done' ? '#22c55e' : h.status === 'error' ? '#ef4444' : h.status === 'cancelled' ? '#f59e0b' : '#3b82f6',
                marginRight: '6px',
              }}>{h.status === 'cancelled' ? '中断' : h.status === 'done' ? '完成' : h.status === 'error' ? '错误' : h.status}</span>
              {h.message.length > 100 ? h.message.slice(0, 100) + '...' : h.message}
            </div>
          ))}
        </div>
      )}

      {data.content && (
        <div
          className="nodrag nowheel"
          style={{
            padding: '8px 14px',
            fontSize: '13px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
            cursor: 'text',
            borderBottom: '1px solid #313244',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {data.content}
        </div>
      )}

      <div
        className="nodrag"
        style={{
          padding: '8px 14px',
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-end',
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter发送, Ctrl+Enter换行)"
          rows={3}
          style={{
            flex: 1,
            minHeight: '72px',
            maxHeight: '150px',
            background: '#181825',
            border: '1px solid #45475a',
            borderRadius: '6px',
            color: '#cdd6f4',
            fontSize: '13px',
            padding: '8px',
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        {isRunning ? (
          <button
            onClick={handleAbort}
            disabled={aborting}
            style={{
              padding: '8px 14px',
              background: aborting ? '#7f1d1d' : '#ef4444',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              fontSize: '13px',
              fontWeight: 600,
              cursor: aborting ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {aborting ? '中止中...' : '中止 ✕'}
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim() || !onContinue || !sessionId}
            style={{
              padding: '8px 14px',
              background: !input.trim() || !sessionId ? '#45475a' : '#a855f7',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              fontSize: '13px',
              fontWeight: 600,
              cursor: !input.trim() || !sessionId ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            发送 ▶
          </button>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: '#a855f7' }} />
    </div>
  );
}

export default memo(StartNodeComponent);
