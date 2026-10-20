import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app.jsx';
import { ClientProjectPage, LoginPage } from './pages.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(data, status=200) {
  return { ok: status >= 200 && status < 300, status, json: async () => status >= 400 ? { error: data } : { data } };
}
function renderApp(initialPath, page, routes=[], pagePath=initialPath) {
  return render(<MemoryRouter initialEntries={[initialPath]} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><AuthProvider><Routes>
    <Route path={pagePath} element={page}/>{routes.map(({path,element})=><Route key={path} path={path} element={element}/>) }
  </Routes></AuthProvider></MemoryRouter>);
}

describe('portal UI', () => {
  it('shows a username and password login for clients and enters the correct portal', async () => {
    const fetch = vi.fn(async (url, options={}) => {
      if (url === '/api/auth/me') return response({ error: { code:'UNAUTHENTICATED', message:'Silakan masuk.' } }, 401);
      if (url === '/api/auth/client/login') return response({ user:{ id:8,username:'dina',displayName:'Dina Putri',role:'client',mustChangePassword:false } });
      return response({ error:{ message:'Not found' } },404);
    });
    vi.stubGlobal('fetch',fetch);
    const user=userEvent.setup();
    renderApp('/client/login',<LoginPage role="client"/>,[{path:'/client/dashboard',element:<h1>Dashboard klien</h1>}]);
    expect(await screen.findByRole('heading',{name:'Senang bertemu lagi'})).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toHaveAttribute('type','password');
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Username/),'dina');
    await user.type(screen.getByLabelText(/Password/),'Dina-Secure-Password!');
    await user.click(screen.getByRole('button',{name:'Masuk'}));
    expect(await screen.findByRole('heading',{name:'Dashboard klien'})).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/client/login',expect.objectContaining({method:'POST',credentials:'include'}));
  });

  it('requires a revision comment and submits the client review action', async () => {
    let status='In Review';
    const posted=[];
    const addedAttachments=[];
    const project=()=>({id:12,name:'Brand refresh',description:'Penyegaran identitas',status:'In Progress',priority:'Normal',dueDate:'2026-11-10',notesClient:'Mohon review hasil ini.',updatedAt:'2026-10-20T08:00:00.000Z',subprojects:[{id:13,projectId:12,title:'Arah visual',description:'Konsep warna',status,dueDate:'2026-10-28',notesClient:'Tinjau palet warna.'}]});
    const fetch=vi.fn(async(url,options={})=>{
      if(url==='/api/auth/me')return response({user:{id:8,username:'dina',displayName:'Dina',role:'client',mustChangePassword:false}});
      if(url==='/api/projects/12'&&options.method!=='POST')return response(project());
      if(url==='/api/projects/12/attachments'||url.startsWith('/api/projects/12/attachments?'))return response([]);
      if(url==='/api/projects/12/attachments/link'&&options.method==='POST'){
        addedAttachments.push(JSON.parse(options.body));
        return response({id:21,title:'Deliverable source'});
      }
      if(url==='/api/projects/12/comments'||url.startsWith('/api/projects/12/comments?'))return response([]);
      if(url==='/api/subprojects/13/review'){
        const body=JSON.parse(options.body);posted.push(body);status=body.action==='revision'?'Needs Revision':'Approved';
        return response({id:13,status,message:'Permintaan revisi dikirim.'});
      }
      return response({error:{message:`Unexpected ${url}`}},404);
    });
    vi.stubGlobal('fetch',fetch);
    const user=userEvent.setup();
    renderApp('/client/projects/12',<ClientProjectPage/>,[],'/client/projects/:id');
    expect(await screen.findByText('Menunggu review Anda')).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:'Lampiran project'})).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:'Lampiran deliverable'})).toBeInTheDocument();
    const addAttachmentButtons=screen.getAllByRole('button',{name:'Tambah lampiran'});
    expect(addAttachmentButtons).toHaveLength(2);
    await user.click(addAttachmentButtons[0]);
    await user.type(screen.getByPlaceholderText('Contoh: Brief final'),'Deliverable source');
    await user.type(screen.getByPlaceholderText('https://…'),'https://example.com/deliverable');
    await user.click(screen.getByRole('button',{name:'Simpan lampiran'}));
    await waitFor(()=>expect(addedAttachments).toEqual([{title:'Deliverable source',url:'https://example.com/deliverable',subprojectId:13}]));
    const revision=screen.getByRole('button',{name:'Minta revisi'});
    expect(revision).toBeDisabled();
    await user.type(screen.getByRole('textbox',{name:'Komentar untuk Arah visual'}),'Warna perlu lebih hangat.');
    expect(revision).toBeEnabled();
    await user.click(revision);
    await waitFor(()=>expect(posted).toEqual([{action:'revision',comment:'Warna perlu lebih hangat.'}]));
    expect(await screen.findByText('Needs Revision')).toBeInTheDocument();
    expect(screen.queryByText('Menunggu review Anda')).not.toBeInTheDocument();
  });
});
