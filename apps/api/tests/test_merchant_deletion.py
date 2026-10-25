from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.database import now_iso, today

PASSWORD = "fixture-password-1234"

@pytest.fixture
def service(tmp_path):
    app=create_app(tmp_path/'deletion.sqlite3')
    app.state.weather_reader=lambda db,store,cutoff:{'status':'ok','source':'test_fixture','mode':'live_forecast','days':[],'fetched_at':'2026-10-24T00:00:00Z','note':'test'}
    with TestClient(app) as client:
        def login(email='owner@hwagae.local',password='hwagae-demo'):
            response=client.post('/auth/login',json={'email':email,'password':password})
            assert response.status_code==200, response.text
            return {'Authorization':'Bearer '+response.json()['token']}
        with app.state.database.connect() as db:
            row=db.execute("SELECT * FROM users WHERE id='demo-owner'").fetchone()
            db.execute('INSERT INTO users VALUES (?,?,?,?,?)',('operator','operator@example.com','운영자',row['salt'],row['password_hash']))
            db.execute('INSERT INTO platform_operators VALUES (?)',('operator',))
        yield app,client,login('operator@example.com'),login

def create(client,auth,email='new@example.com'):
    return client.post('/admin/contracts',headers=auth,json={'email':email,'merchant_name':'새 점주','starts_on':today().isoformat(),'ends_on':(today()+timedelta(days=365)).isoformat()})

def accept(client,token):
    return client.post('/auth/invitations/accept',json={'token':token,'password':PASSWORD})

def other_merchant(client,operator,login):
    assert accept(client,create(client,operator).json()['invite']['token']).status_code==201
    auth=login('new@example.com',PASSWORD)
    store=client.post('/stores',headers=auth,json={'name':'다른 매장','city':'서울','latitude':37.5,'longitude':127,'timezone':'Asia/Seoul'})
    assert store.status_code==201,store.text
    return auth,store.json()['id']

def store_tables(db):
    names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    return [t for t in names if any(c['name']=='store_id' for c in db.execute(f'PRAGMA table_info("{t}")'))]

def store_rows(db,store_id):
    rows={t:[tuple(r) for r in db.execute(f'SELECT * FROM "{t}" WHERE store_id=? ORDER BY rowid',(store_id,))] for t in store_tables(db)}
    return {**rows,'stores':[tuple(r) for r in db.execute('SELECT * FROM stores WHERE id=?',(store_id,))]}

def test_operator_deletes_contracted_merchant_stores_and_retires_account(service):
    app,client,operator,login=service
    owner,staff=login(),login('staff@hwagae.local')
    contract=create(client,operator,email='owner@hwagae.local').json()
    assert contract['existing_account']
    stock=client.put('/stores/gwangju/inventory/P001',headers=owner,json={'batches':[{'quantity':0,'expires_on':(today()+timedelta(days=2)).isoformat()}],'incoming':[],'incoming_confirmed':True})
    assert stock.status_code==200,stock.text
    forecast=client.post('/stores/gwangju/forecasts',headers=owner).json()
    rec=client.post('/stores/gwangju/recommendations',headers=owner,json={'forecast_id':forecast['id']}).json()
    order=client.post('/stores/gwangju/orders',headers=staff,json={'recommendation_id':rec['id'],'lines':[{'product_id':'P001','quantity':3}]})
    assert order.status_code==201,order.text
    other,other_store=other_merchant(client,operator,login)
    with app.state.database.connect() as db:
        db.execute("INSERT INTO model_demo_workspaces VALUES ('demo-owner','sample',0,'{}',?)",(now_iso(),))
        before=store_rows(db,'gwangju')
        assert all(before[t] for t in ('products','sales','inventory','orders','recommendations','forecasts','memberships','staff_access'))
        untouched=store_rows(db,other_store)
    path=f"/admin/contracts/{contract['id']}/delete"
    assert client.post(path).status_code==401
    assert client.post(path,headers=owner).status_code==403
    assert client.post(path,headers=staff).status_code==403
    assert client.post('/admin/merchants/demo-owner/delete',headers=other).status_code==403
    result=client.post(path,headers=operator)
    assert result.status_code==200,result.text
    assert result.json()=={'ok':True,'deleted_stores':2}
    with app.state.database.connect() as db:
        for store_id in ('gwangju','busan'):
            assert not any(store_rows(db,store_id).values())
        assert store_rows(db,other_store)==untouched
        user=db.execute("SELECT * FROM users WHERE id='demo-owner'").fetchone()
        assert user['email']=='deleted-demo-owner@deleted.invalid' and user['name']=='삭제된 점주'
        assert db.execute("SELECT enabled FROM account_controls WHERE user_id='demo-owner'").fetchone()[0]==0
        for table in ('memberships','sessions','merchant_contracts','model_demo_workspaces'):
            assert not db.execute(f"SELECT 1 FROM {table} WHERE user_id='demo-owner'").fetchone()
        assert not db.execute('SELECT 1 FROM merchant_invites WHERE contract_id=?',(contract['id'],)).fetchone()
        assert db.execute("SELECT email FROM users WHERE id='demo-staff'").fetchone()[0]=='staff@hwagae.local'
        assert not db.execute("SELECT 1 FROM memberships WHERE user_id='demo-staff'").fetchone()
        assert [tuple(r) for r in db.execute("SELECT actor_id,subject_id FROM operator_audit WHERE action='merchant.delete'")]==[('operator','demo-owner')]
    assert client.get('/auth/me',headers=owner).status_code==401
    assert client.post('/auth/login',json={'email':'owner@hwagae.local','password':'hwagae-demo'}).status_code==401
    assert client.get('/auth/me',headers=staff).status_code==401
    assert client.get('/stores',headers=login('staff@hwagae.local')).json()['stores']==[]
    assert len(client.get('/stores',headers=other).json()['stores'])==1
    overview=client.get('/admin/overview',headers=operator).json()
    assert overview['counts']['stores']==1
    assert all(c['email']!='owner@hwagae.local' for c in overview['contracts'])
    assert not overview['existing_merchants']
    assert client.post(path,headers=operator).status_code==404
    assert client.post('/admin/merchants/demo-owner/delete',headers=operator).status_code==404
    again=create(client,operator,email='owner@hwagae.local').json()
    assert not again['existing_account']
    assert accept(client,again['invite']['token']).status_code==201
    assert client.get('/stores',headers=login('owner@hwagae.local',PASSWORD)).json()['stores']==[]

def test_shared_store_keeps_other_owner_and_legacy_owner_route(service):
    app,client,operator,login=service
    other,_=other_merchant(client,operator,login)
    with app.state.database.connect() as db:
        other_id=db.execute("SELECT id FROM users WHERE email='new@example.com'").fetchone()[0]
        db.execute("INSERT INTO memberships VALUES (?,'busan','owner')",(other_id,))
        busan=store_rows(db,'busan')
    result=client.post('/admin/merchants/demo-owner/delete',headers=operator)
    assert result.status_code==200,result.text
    assert result.json()['deleted_stores']==1
    with app.state.database.connect() as db:
        assert not any(store_rows(db,'gwangju').values())
        after=store_rows(db,'busan')
        assert after['memberships']==[(other_id,'busan','owner')]
        assert {t:r for t,r in after.items() if t!='memberships'}=={t:r for t,r in busan.items() if t!='memberships'}
    assert client.get('/stores/busan/products',headers=other).status_code==200

def test_delete_refuses_operators_unknown_ids_and_removes_pending_contract(service):
    app,client,operator,login=service
    assert client.post('/admin/merchants/operator/delete',headers=operator).status_code==400
    assert client.post('/admin/merchants/missing/delete',headers=operator).status_code==404
    assert client.post('/admin/merchants/demo-staff/delete',headers=operator).status_code==404
    assert client.post('/admin/contracts/missing/delete',headers=operator).status_code==404
    pending=create(client,operator).json()
    result=client.post(f"/admin/contracts/{pending['id']}/delete",headers=operator)
    assert result.status_code==200 and result.json()['deleted_stores']==0
    assert accept(client,pending['invite']['token']).status_code==400
    with app.state.database.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM stores').fetchone()[0]==2
        assert not db.execute('SELECT 1 FROM merchant_contracts').fetchone()
        assert not db.execute('SELECT 1 FROM merchant_invites').fetchone()
        assert db.execute("SELECT subject_id FROM operator_audit WHERE action='contract.delete'").fetchone()[0]==pending['id']
    assert client.get('/auth/me',headers=login()).status_code==200
