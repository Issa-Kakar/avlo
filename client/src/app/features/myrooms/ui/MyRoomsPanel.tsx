import { useEffect, useState } from 'react';
import { listRooms, removeFromList, deleteLocalCopy } from '../store';
import { toast } from '../../../utils/toast';

type Row = Awaited<ReturnType<typeof listRooms>>[number];

export default function MyRoomsPanel(props: {
  onOpen: (roomId: string) => void;
  onCopyLink: (roomId: string) => Promise<void>; // must use server id;
  onExtend: (roomId: string) => Promise<Date>;   // returns new expiry
  destroyYjsPersistence: (roomId: string) => Promise<void>; // per-room
}) {
  const [rows, setRows] = useState<Row[]>([]);
  async function refresh() { setRows(await listRooms()); }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="p-3 space-y-2">
      {rows.map((r) => (
        <div key={r.roomId} className="flex items-center justify-between rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium truncate">{r.title}</div>
            <div className="text-sm opacity-70">
              {r.expires_at ? `Expires in ${daysUntil(r.expires_at)} days.` : '—'}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>props.onOpen(r.roomId)} className="px-2 py-1 border rounded">Open</button>
            <button onClick={async ()=>{
              await props.onCopyLink(r.roomId);
              toast.success('Link copied.');
            }} className="px-2 py-1 border rounded">Copy link</button>
            <button onClick={async ()=>{
              const newExpiry = await props.onExtend(r.roomId);
              toast.success(`Room extended to ${newExpiry.toLocaleDateString()}.`);
              await refresh();
            }} className="px-2 py-1 border rounded">Extend</button>
            <Menu roomId={r.roomId} onAfter={refresh} destroyYjsPersistence={props.destroyYjsPersistence} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Menu(props: { roomId: string; onAfter: ()=>void; destroyYjsPersistence: (roomId: string)=>Promise<void> }) {
  return (
    <div className="relative">
      {/* replace with your menu component */}
      <details>
        <summary className="px-2 py-1 border rounded">•••</summary>
        <div className="absolute right-0 mt-1 w-48 rounded border bg-white shadow">
          <button className="block w-full text-left px-3 py-2 hover:bg-gray-100"
            onClick={async ()=>{ await removeFromList(props.roomId); toast.success('Removed from list'); props.onAfter(); }}>
            Remove from list
          </button>
          <button className="block w-full text-left px-3 py-2 hover:bg-gray-100"
            onClick={async ()=>{ await deleteLocalCopy(props.roomId, ()=>props.destroyYjsPersistence(props.roomId)); toast.success('Local copy deleted'); }}>
            Delete local copy
          </button>
        </div>
      </details>
    </div>
  );
}

function daysUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24*60*60*1000)));
}