import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BriefcaseBusiness, Check, ChevronDown, ChevronRight, CircleHelp, FolderKanban, LayoutDashboard, LogOut, Menu, Plus, Settings, Users, X } from 'lucide-react';
import { api, formatDate, formatTime } from './api.js';
import { AgencyDashboard, ClientDetail, ClientsPage, ClientDashboard, ClientProjectPage, LoginPage, NotFoundPage, ProjectDetailPage, ProjectsPage, SettingsPage } from './pages.jsx';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); const [loading, setLoading] = useState(true);
  const refresh = async () => { try { const result = await api('/auth/me'); setUser(result.user); } catch { setUser(null); } finally { setLoading(false); } };
  useEffect(() => { refresh(); }, []);
  const value = useMemo(() => ({ user, setUser, loading, refresh }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function Guard({ role, children }) {
  const { user, loading } = useAuth(); const location = useLocation();
  if (loading) return <div className="page-loading"><span className="spinner" /> Memuat Workyuk…</div>;
  if (!user) return <Navigate to={`/${role}/login`} replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={`/${user.role}/dashboard`} replace />;
  if (user.mustChangePassword && location.pathname !== '/client/change-password') return <Navigate to="/client/change-password" replace />;
  return children;
}

function AppShell({ role }) {
  const { user, setUser } = useAuth(); const [menuOpen, setMenuOpen] = useState(false); const [profileOpen, setProfileOpen] = useState(false); const navigate = useNavigate();
  const agency = role === 'agency';
  const nav = agency ? [
    { to: '/agency/dashboard', label: 'Ringkasan', icon: LayoutDashboard },
    { to: '/agency/clients', label: 'Klien', icon: Users },
    { to: '/agency/projects', label: 'Project', icon: FolderKanban },
  ] : [
    { to: '/client/dashboard', label: 'Beranda', icon: LayoutDashboard },
    { to: '/client/projects', label: 'Project saya', icon: FolderKanban },
  ];
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* session can already be expired */ } setUser(null); navigate(`/${role}/login`); };
  return <div className={`app-shell ${agency ? 'agency-shell' : 'client-shell'}`}>
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-row"><NavLink to={`/${role}/dashboard`} className="brand"><span className="brand-mark">w</span><span>workyuk</span></NavLink><button className="icon-button mobile-only" aria-label="Tutup menu" onClick={() => setMenuOpen(false)}><X size={20}/></button></div>
      <div className="workspace-label">{agency ? 'WORKSPACE AGENCY' : 'AREA KLIEN'}</div>
      <nav className="side-nav" aria-label="Navigasi utama">{nav.map(({to,label,icon:Icon})=><NavLink key={to} to={to} onClick={()=>setMenuOpen(false)} className={({isActive})=>`side-link ${isActive?'active':''}`}><Icon size={18}/><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-help"><span className="help-icon"><CircleHelp size={17}/></span><div><strong>Butuh bantuan?</strong><span>Hubungi tim Workyuk</span></div><ChevronRight size={16}/></div>
      <div className="side-account"><div className="avatar">{(user?.displayName||'W').slice(0,1).toUpperCase()}</div><div className="account-copy"><strong>{user?.displayName}</strong><span>{agency?'Agency':'Client'}</span></div><button className="icon-button account-menu-trigger" aria-label="Buka pengaturan akun" onClick={()=>setProfileOpen((v)=>!v)}><ChevronDown size={17}/></button>
        {profileOpen&&<div className="profile-menu"><NavLink to={`/${role}/settings`} onClick={()=>setProfileOpen(false)}><Settings size={16}/> Pengaturan akun</NavLink><button onClick={logout}><LogOut size={16}/> Keluar</button></div>}
      </div>
    </aside>
    {menuOpen&&<button className="mobile-scrim" aria-label="Tutup navigasi" onClick={()=>setMenuOpen(false)}/>}
    <main className="main-area"><header className="topbar"><button className="icon-button mobile-only" aria-label="Buka menu" onClick={()=>setMenuOpen(true)}><Menu size={20}/></button><div className="breadcrumb"><span>{agency?'Workspace agency':'Portal klien'}</span><ChevronRight size={14}/><strong>{navLabel(useLocation().pathname)}</strong></div><div className="topbar-right"><div className="topbar-date">{new Intl.DateTimeFormat('id-ID',{weekday:'long',day:'numeric',month:'long'}).format(new Date())}</div><div className="avatar avatar-small">{(user?.displayName||'W').slice(0,1).toUpperCase()}</div></div></header><div className="main-content"><Outlet/></div></main>
  </div>;
}
function navLabel(path) { if(path.includes('/clients'))return path.endsWith('/new')?'Klien baru':path.split('/').length>3?'Detail klien':'Klien';if(path.includes('/projects'))return path.endsWith('/new')?'Project baru':path.split('/').length>3?'Detail project':'Project';if(path.endsWith('settings')||path.endsWith('change-password'))return 'Pengaturan';return path.includes('dashboard')?'Ringkasan':'Beranda'; }

export function PageHeader({ eyebrow, title, description, action, back }) {
  return <div className="page-header"><div className="page-header-copy">{back&&<button type="button" className="back-link" onClick={back}>← Kembali</button>}<div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description&&<p>{description}</p>}</div>{action&&<div className="page-header-action">{action}</div>}</div>;
}
export function PrimaryButton({ children, onClick, type='button', disabled=false, icon:Icon, className='' }) { return <button type={type} disabled={disabled} onClick={onClick} className={`button button-primary ${className}`}>{Icon&&<Icon size={17}/>}<span>{children}</span></button>; }
export function SecondaryButton({ children, onClick, type='button', icon:Icon, className='', disabled=false }) { return <button type={type} disabled={disabled} onClick={onClick} className={`button button-secondary ${className}`}>{Icon&&<Icon size={17}/>}<span>{children}</span></button>; }
export function StatusBadge({ status }) { const type=String(status||'').toLowerCase().replaceAll(' ','-');return <span className={`status-badge status-${type}`}>{status||'Belum ada status'}</span>; }
export function PriorityBadge({ priority }) { return <span className={`priority priority-${String(priority||'normal').toLowerCase()}`}><i/>{priority||'Normal'}</span>; }
export function EmptyState({ icon:Icon=BriefcaseBusiness, title, text, action }) { return <div className="empty-state"><span className="empty-icon"><Icon size={22}/></span><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function ErrorNotice({ error, onRetry }) { if(!error)return null;return <div className="error-notice" role="alert"><span>{error.message||String(error)}</span>{onRetry&&<button onClick={onRetry}>Coba lagi</button>}</div>; }
export function LoadingState({ label='Memuat data…' }) { return <div className="loading-state"><span className="spinner"/>{label}</div>; }
export function Modal({ title, onClose, children, size='' }) { useEffect(()=>{const onKey=(e)=>e.key==='Escape'&&onClose();window.addEventListener('keydown',onKey);document.body.style.overflow='hidden';return()=>{window.removeEventListener('keydown',onKey);document.body.style.overflow='';};},[onClose]);return <div className="modal-backdrop" onMouseDown={(e)=>e.target===e.currentTarget&&onClose()}><section className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="Tutup" onClick={onClose}><X size={19}/></button></header><div className="modal-body">{children}</div></section></div>; }
export function Toast({ message, onClose }) { useEffect(()=>{const timer=setTimeout(onClose,4000);return()=>clearTimeout(timer);},[onClose]);return <div className="toast" role="status"><span className="toast-check"><Check size={15}/></span>{message}<button onClick={onClose} aria-label="Tutup"><X size={16}/></button></div>; }
export function useToast() { const [toast,setToast]=useState('');const show=(message)=>setToast(message);const close=()=>setToast('');return {toast,show,close}; }

export function App() {
  return <Routes>
    <Route path="/" element={<Navigate to="/agency/login" replace/>}/>
    <Route path="/agency/login" element={<LoginPage role="agency"/>}/><Route path="/client/login" element={<LoginPage role="client"/>}/>
    <Route path="/agency" element={<Guard role="agency"><AppShell role="agency"/></Guard>}>
      <Route index element={<Navigate to="dashboard" replace/>}/><Route path="dashboard" element={<AgencyDashboard/>}/><Route path="clients" element={<ClientsPage/>}/><Route path="clients/new" element={<ClientsPage create/>}/><Route path="clients/:id" element={<ClientDetail/>}/><Route path="projects" element={<ProjectsPage/>}/><Route path="projects/new" element={<ProjectsPage create/>}/><Route path="projects/:id" element={<ProjectDetailPage/>}/><Route path="settings" element={<SettingsPage/>}/>
    </Route>
    <Route path="/client" element={<Guard role="client"><AppShell role="client"/></Guard>}>
      <Route index element={<Navigate to="dashboard" replace/>}/><Route path="dashboard" element={<ClientDashboard/>}/><Route path="projects" element={<ClientDashboard listOnly/>}/><Route path="projects/:id" element={<ClientProjectPage/>}/><Route path="settings" element={<SettingsPage/>}/><Route path="change-password" element={<SettingsPage forced/>}/>
    </Route>
    <Route path="*" element={<NotFoundPage/>}/>
  </Routes>;
}
export default App;
