import { useCallback, useState, useRef, useEffect } from 'react';
import { ReactFlow, Background, Controls, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useDAGStore } from './stores/dagStore';
import RoleNode from './components/RoleNode';

const nodeTypes: NodeTypes = { roleNode: RoleNode };

export default function App() {
  const [message, setMessage] = useState('');
  const [teamId, setTeamId] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [taskList, setTaskList] = useState<any[]>([]);
  const [viewport] = useState(() => {
    try {
      const saved = localStorage.getItem('dagViewport');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { x: 0, y: 0, zoom: 0.8 };
  });
  const { nodes, edges, taskId, taskStatus, setTask, setTaskStatus, handleEvent, reset, initTeam } = useDAGStore();
  const eventSourceRef = useRef<EventSource | null>(null);
  const rfRef = useRef<any>(null);

  // 页面加载时恢复最新任务
  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch('/api/tasks');
        const tasks = await res.json();
        setTaskList(tasks);
        // 优先用 API 最新任务，fallback 到 localStorage
        const saved = localStorage.getItem('currentTaskId');
        const tid = saved || tasks[0]?.taskId;
        if (tid) {
          await restoreTask(tid);
        }
      } catch {}
    };
    init();
  }, []);

  const loadTaskList = async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      setTaskList(data);
    } catch {}
  };

  const restoreTask = async (tid: string) => {
    try {
      const res = await fetch(`/api/tasks/${tid}`);
      const data = await res.json();
      if (!data.taskId) return;
      reset();
      setSelectedTeam(data.teamId || 'auto');
      if (data.teamId) {
        const teamRes = await fetch(`/api/teams/${data.teamId}`);
        const team = await teamRes.json();
        if (team.roles) {
          initTeam(tid, team.roles, team.strategy);
        } else {
          setTask(tid);
        }
      } else {
        setTask(tid);
      }
      for (const event of data.events) {
        handleEvent(event);
      }
      setTaskStatus(data.status);
      if (data.status === 'running') {
        connectSSE(tid);
      }
    } catch {}
  };

  const handleSubmit = useCallback(async () => {
    if (!message.trim()) return;
    setLoading(true);
    reset();

    try {
      const body: any = { message };
      if (teamId.trim()) body.teamId = teamId.trim();
      body.workdir = 'D:\\000agent\\opensource\\myteam';

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.taskId) {
        localStorage.setItem('currentTaskId', data.taskId);
        setSelectedTeam(data.teamId || 'auto');
        reset();
        const teamRes = await fetch(`/api/teams/${data.teamId}`);
        const team = await teamRes.json();
        if (team.roles) {
          initTeam(data.taskId, team.roles, team.strategy);
        }
        connectSSE(data.taskId);
        loadTaskList();
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setLoading(false);
    }
  }, [message, teamId, reset, setTask]);

  const connectSSE = useCallback((tid: string) => {
    if (eventSourceRef.current) eventSourceRef.current.close();

    const es = new EventSource(`/api/tasks/${tid}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'task_done') {
          setTaskStatus(data.status || 'done');
          es.close();
        } else {
          handleEvent(data);
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.onerror = () => {
      // EventSource 会自动重连
    };
  }, [handleEvent, setTaskStatus]);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#11111b' }}>
      {/* 左侧任务历史侧边栏 */}
      <div style={{ width: '240px', background: '#181825', borderRight: '1px solid #313244', overflow: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '16px 12px 8px', color: '#6c7086', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          历史任务
        </div>
        {taskList.length === 0 && (
          <div style={{ padding: '8px 12px', color: '#6c7086', fontSize: '13px' }}>暂无</div>
        )}
        {taskList.map(t => (
          <div
            key={t.taskId}
            onClick={() => { localStorage.setItem('currentTaskId', t.taskId); reset(); restoreTask(t.taskId); }}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              borderBottom: '1px solid #31324422',
              color: taskId === t.taskId ? '#cdd6f4' : '#7f849c',
              background: taskId === t.taskId ? '#31324433' : 'transparent',
              fontSize: '13px',
              transition: 'all 0.15s',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#31324422'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = taskId === t.taskId ? '#31324433' : 'transparent'; }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '4px',
                background: t.status === 'done' ? '#22c55e22' : t.status === 'error' ? '#ef444422' : '#3b82f622',
                color: t.status === 'done' ? '#22c55e' : t.status === 'error' ? '#ef4444' : '#3b82f6',
              }}>{t.status}</span>
              <span style={{ fontSize: '10px', color: '#6c7086' }}>{t.teamId}</span>
            </div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.message}
            </div>
          </div>
        ))}
      </div>

      {/* 右侧主区域 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* 顶部输入栏 */}
      <div style={{
        padding: '16px 24px',
        background: '#181825',
        borderBottom: '1px solid #313244',
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
      }}>
        <div style={{ color: '#cdd6f4', fontWeight: 'bold', fontSize: '18px', marginRight: '8px' }}>
          MyTeam
        </div>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading) handleSubmit(); }}
          placeholder="输入一句话任务..."
          style={{
            flex: 1,
            padding: '10px 14px',
            background: '#1e1e2e',
            border: '1px solid #45475a',
            borderRadius: '8px',
            color: '#cdd6f4',
            fontSize: '14px',
            outline: 'none',
          }}
        />
        <input
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          placeholder="自动选择"
          style={{
            width: '120px',
            padding: '10px 14px',
            background: '#1e1e2e',
            border: '1px solid #45475a',
            borderRadius: '8px',
            color: '#cdd6f4',
            fontSize: '14px',
            outline: 'none',
            textAlign: 'center',
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={loading || !message.trim()}
          style={{
            padding: '10px 20px',
            background: loading ? '#45475a' : '#6366f1',
            border: 'none',
            borderRadius: '8px',
            color: 'white',
            fontSize: '14px',
            fontWeight: 'bold',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '启动中...' : '执行 ▶'}
        </button>
      </div>

      {/* DAG 流程图区域 */}
      <div style={{ flex: 1, position: 'relative' }}>
        {taskId ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(inst: any) => {
              rfRef.current = inst;
              const saved = localStorage.getItem('dagViewport');
              if (saved) {
                try { inst.setViewport(JSON.parse(saved)); return; } catch {}
              }
              inst.fitView({ padding: 0.2 });
            }}
            onMoveEnd={() => {
              if (rfRef.current) {
                try { localStorage.setItem('dagViewport', JSON.stringify(rfRef.current.getViewport())); } catch {}
              }
            }}
            style={{ background: '#11111b' }}
            defaultEdgeOptions={{
              style: { stroke: '#6366f1', strokeWidth: 2 },
              animated: true,
            }}
          >
            <Background color="#313244" gap={20} />
            <Controls style={{ background: '#1e1e2e' }} />
          </ReactFlow>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#6c7086',
            fontSize: '18px',
          }}>
            输入任务后，DAG 流程图将在此显示
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      {taskId && (
        <div style={{
          padding: '8px 24px',
          background: '#181825',
          borderTop: '1px solid #313244',
          color: '#6c7086',
          fontSize: '12px',
          display: 'flex',
          gap: '24px',
        }}>
          <span>团队: <strong style={{ color: '#6366f1' }}>{selectedTeam}</strong></span>
          <span>Task: {taskId.slice(0, 12)}...</span>
          <span>状态: {taskStatus || '运行中'}</span>
          <span>节点: {nodes.length}</span>
          <span>边: {edges.length}</span>
        </div>
      )}
      </div>
    </div>
  );
}
