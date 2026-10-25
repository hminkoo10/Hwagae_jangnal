import hashlib
import json
from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.database import now_iso, today

PASSWORD = "fixture-password-1234"

@pytest.fixture
def service(tmp_path):
    app=create_app(tmp_path/'platform.sqlite3')
    with TestClient(app) as client:
        def login(email='owner@hwagae.local',password='hwagae-demo'):
            response=client.post('/auth/login',json={'email':email,'password':password})
            assert response.status_code==200, response.text
            return {'Authorization':'Bearer '+response.json()['token']}
        merchant=login()
        with app.state.database.connect() as db:
            # The fixture operator is not a store member, as in production.
            row=db.execute("SELECT * FROM users WHERE id='demo-owner'").fetchone()
            db.execute('INSERT INTO users VALUES (?,?,?,?,?)',('operator','operator@example.com','운영자',row['salt'],row['password_hash']))
            db.execute('INSERT INTO platform_operators VALUES (?)',('operator',))
        operator=login('operator@example.com')
        yield app,client,merchant,operator,login

def create(client,auth,email='new@example.com',**values):
    return client.post('/admin/contracts',headers=auth,json={'email':email,'merchant_name':'새 점주','starts_on':today().isoformat(),'ends_on':(today()+timedelta(days=365)).isoformat(),**values})

def accept(client,token,**extra):
    return client.post('/auth/invitations/accept',json={'token':token,'password':PASSWORD,**extra})

def test_operator_separation_and_no_public_role_escalation(service):
    app,client,merchant,operator,login=service
    assert client.get('/admin/overview').status_code==401
    assert client.get('/admin/overview',headers=merchant).status_code==403
    assert create(client,merchant).status_code==403
    assert client.get('/auth/me',headers=operator).json()['platform_role']=='operator'
    assert client.get('/stores',headers=operator).json()['stores']==[]
    assert client.get('/platform/ai/settings',headers=operator).status_code==200
    assert client.get('/platform/ai/settings',headers=merchant).status_code==403
    assert create(client,operator,email='operator@example.com').status_code==400

def test_unlinked_merchant_store_summary_matches_after_contract_connection(service):
    _,client,merchant,operator,_=service
    overview=client.get('/admin/overview',headers=operator).json()
    existing=next(row for row in overview['existing_merchants'] if row['email']=='owner@hwagae.local')
    assert {store['id'] for store in existing['stores']}=={'gwangju','busan'}
    assert all(store['product_count']==10 and store['last_sales_date'] for store in existing['stores'])
    assert client.get('/admin/overview',headers=merchant).status_code==403
    assert create(client,operator,email='owner@hwagae.local').status_code==201
    after=client.get('/admin/overview',headers=operator).json()
    assert not after['existing_merchants']
    assert after['contracts'][0]['stores']==existing['stores']

def test_contract_invite_accept_first_store_and_tenant_isolation(service):
    app,client,merchant,operator,login=service
    response=create(client,operator); assert response.status_code==201,response.text
    payload=response.json(); token=payload['invite']['token']
    with app.state.database.connect() as db:
        row=db.execute('SELECT * FROM merchant_invites').fetchone()
        assert row['token_hash']==hashlib.sha256(token.encode()).hexdigest()
        assert token not in json.dumps(dict(row))
    assert token not in client.get('/admin/overview',headers=operator).text
    assert client.post('/auth/invitations/inspect',json={'token':token}).json()['email']=='new@example.com'
    result=accept(client,token,platform_role='operator')
    assert result.status_code==422 and PASSWORD not in result.text and token not in result.text
    assert accept(client,token).status_code==201
    assert accept(client,token).status_code==400
    new=login('new@example.com',PASSWORD)
    assert client.get('/admin/overview',headers=new).status_code==403
    assert client.get('/stores',headers=new).json()['stores']==[]
    assert client.get('/stores/gwangju/products',headers=new).status_code==403
    result=client.post('/stores',headers=new,json={'name':'새 매장','city':'서울','latitude':37.5,'longitude':127,'timezone':'Asia/Seoul'})
    assert result.status_code==201,result.text
    assert len(client.get('/stores',headers=new).json()['stores'])==1
    assert client.get(f"/stores/{result.json()['id']}/products",headers=merchant).status_code==403

def test_invite_reissue_revokes_old_and_expired_links(service):
    app,client,_,operator,_=service
    response=create(client,operator).json(); old=response['invite']['token']; contract=response['id']
    newer=client.post(f'/admin/contracts/{contract}/invite',headers=operator).json()['token']
    assert accept(client,old).status_code==400
    with app.state.database.connect() as db:
        db.execute("UPDATE merchant_invites SET expires_at='2000-01-01T00:00:00+00:00'")
    assert accept(client,newer).status_code==400

def test_short_password_never_echoes_secret_or_consumes_invite(service):
    _,client,_,operator,_=service
    token=create(client,operator).json()['invite']['token']
    result=client.post('/auth/invitations/accept',json={'token':token,'password':'short123'})
    assert result.status_code==422 and 'short123' not in result.text and token not in result.text
    assert accept(client,token).status_code==201

@pytest.mark.parametrize('status,enabled', [('suspended',True),('active',False)])
def test_pause_revokes_sessions_and_staff_store_access_without_deleting_data(service,status,enabled):
    app,client,merchant,operator,login=service
    staff=login('staff@hwagae.local')
    response=create(client,operator,email='owner@hwagae.local').json()
    assert response['existing_account'] and response['invite'] is None
    with app.state.database.connect() as db:
        before=[tuple(r) for r in db.execute('SELECT * FROM sales ORDER BY store_id,product_id,date')]
    endpoint=f"/admin/contracts/{response['id']}"
    body={'starts_on':today().isoformat(),'ends_on':(today()+timedelta(days=365)).isoformat(),'status':status,'enabled':enabled}
    assert client.patch(endpoint,headers=operator,json=body).status_code==200
    assert client.get('/auth/me',headers=merchant).status_code==401
    assert client.post('/auth/login',json={'email':'owner@hwagae.local','password':'hwagae-demo'}).status_code==403
    assert client.get('/stores/gwangju/products',headers=staff).status_code==403
    assert client.get('/stores',headers=staff).json()['stores']==[]
    assert client.patch(endpoint,headers=operator,json={**body,'status':'active','enabled':True}).status_code==200
    active=login()
    assert client.get('/stores/gwangju/products',headers=active).status_code==200
    with app.state.database.connect() as db:
        assert [tuple(r) for r in db.execute('SELECT * FROM sales ORDER BY store_id,product_id,date')]==before
        assert db.execute('SELECT COUNT(*) FROM operator_audit').fetchone()[0]==3

@pytest.mark.parametrize('offset', [-2,2])
def test_contract_window_enforced_on_existing_sessions(service,offset):
    _,client,merchant,operator,_=service
    start=today()+timedelta(days=offset)
    end=start+timedelta(days=1)
    assert create(client,operator,email='owner@hwagae.local',starts_on=start.isoformat(),ends_on=end.isoformat()).status_code==201
    assert client.get('/auth/me',headers=merchant).status_code==401

def test_duplicate_contract_and_invalid_dates_are_rejected(service):
    _,client,_,operator,_=service
    assert create(client,operator).status_code==201
    assert create(client,operator).status_code==409
    assert create(client,operator,email='other@example.com',ends_on='2000-01-01').status_code==422

def test_concurrent_invite_accept_creates_only_one_account(service):
    from concurrent.futures import ThreadPoolExecutor
    app,client,_,operator,_=service
    token=create(client,operator).json()['invite']['token']
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:accept(client,token).status_code,range(2)))
    assert sorted(results)==[201,400]
    with app.state.database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM users WHERE email='new@example.com'").fetchone()[0]==1

def test_bootstrap_is_explicit_and_does_not_reset_existing_operator(service,tmp_path,monkeypatch):
    import sys
    import os
    from app.bootstrap_owner import main
    from app.database import password_matches
    app,client,_,operator,_=service
    output=tmp_path/'operator-initial.txt'
    monkeypatch.setenv('DB_PATH',str(app.state.database.path))
    monkeypatch.setattr(sys,'argv',['bootstrap_owner','--email','fresh@example.com','--credentials-output',str(output)])
    main()
    original=output.read_text(encoding='utf-8')
    password=original.split('Password: ')[1].strip()
    with app.state.database.connect() as db:
        row=db.execute("SELECT * FROM users WHERE email='fresh@example.com'").fetchone()
        assert password_matches(password,row['salt'],row['password_hash'])
        assert db.execute('SELECT 1 FROM platform_operators WHERE user_id=?',(row['id'],)).fetchone()
    if os.name!='nt':
        assert output.stat().st_mode&0o777==0o600
    main()
    assert output.read_text(encoding='utf-8')==original
