import hashlib
import json
from datetime import timedelta
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.database import today
from app.staff import DEFAULT_PERMISSIONS, PERMISSIONS

PASSWORD = "fixture-password-1234"

@pytest.fixture
def service(tmp_path):
    app=create_app(tmp_path/'staff.sqlite3')
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
        yield app,client,login

def invite(client,auth,email='clerk@example.com',store='gwangju',**values):
    return client.post(f'/stores/{store}/staff',headers=auth,json={'name':'새 직원','email':email,**values})

def accept(client,token,password=PASSWORD):
    return client.post('/auth/staff-invitations/accept',json={'token':token,'password':password})

def staff_row(client,auth,email,store='gwangju'):
    return next(row for row in client.get(f'/stores/{store}/staff',headers=auth).json()['staff'] if row['email']==email)

def stock(client,auth):
    return client.put('/stores/gwangju/inventory/P001',headers=auth,json={'batches':[{'quantity':0,'expires_on':(today()+timedelta(days=2)).isoformat()}],'incoming':[],'incoming_confirmed':True})

def draft(client,auth):
    forecast=client.post('/stores/gwangju/forecasts',headers=auth).json()
    rec=client.post('/stores/gwangju/recommendations',headers=auth,json={'forecast_id':forecast['id']}).json()
    return client.post('/stores/gwangju/orders',headers=auth,json={'recommendation_id':rec['id'],'lines':[{'product_id':'P001','quantity':3}]})

def test_invite_inspect_accept_is_hashed_single_use_and_scoped(service):
    app,client,login=service
    owner=login()
    response=invite(client,owner,email=' Clerk@Example.com ')
    assert response.status_code==201,response.text
    body=response.json(); token=body['invite']['token']
    assert not body['existing_account']
    with app.state.database.connect() as db:
        row=db.execute('SELECT * FROM staff_invites').fetchone()
        assert row['token_hash']==hashlib.sha256(token.encode()).hexdigest() and token not in json.dumps(dict(row))
    listed=client.get('/stores/gwangju/staff',headers=owner)
    assert token not in listed.text
    assert staff_row(client,owner,'clerk@example.com')['status']=='invited'
    assert invite(client,owner).status_code==409
    info=client.post('/auth/staff-invitations/inspect',json={'token':token}).json()
    assert info['email']=='clerk@example.com' and info['store_name']=='화개장날 동명점'
    short=accept(client,token,'short123')
    assert short.status_code==422 and 'short123' not in short.text and token not in short.text
    assert client.post('/auth/invitations/accept',json={'token':token,'password':PASSWORD}).status_code==400
    assert accept(client,token).status_code==201
    assert accept(client,token).status_code==400
    clerk=login('clerk@example.com',PASSWORD)
    assert client.get('/auth/me',headers=clerk).json()['platform_role']=='merchant'
    stores=client.get('/stores',headers=clerk).json()['stores']
    assert [(s['id'],s['role'],s['permissions']) for s in stores]==[('gwangju','staff',DEFAULT_PERMISSIONS)]
    assert client.get('/stores/busan/products',headers=clerk).status_code==403
    assert client.post('/stores',headers=clerk,json={'name':'몰래 매장','city':'서울','latitude':37.5,'longitude':127}).status_code==403
    row=staff_row(client,owner,'clerk@example.com')
    assert row['status']=='active' and row['kind']=='member' and row['joined_at']

def test_reissue_revokes_old_link_and_expired_or_cancelled_links_fail(service):
    app,client,login=service
    owner=login()
    body=invite(client,owner).json(); old=body['invite']['token']
    newer=client.post(f"/stores/gwangju/staff/invites/{body['id']}/reissue",headers=owner).json()['token']
    assert accept(client,old).status_code==400
    with app.state.database.connect() as db:
        db.execute("UPDATE staff_invites SET expires_at='2000-01-01T00:00:00+00:00'")
    assert accept(client,newer).status_code==400
    assert staff_row(client,owner,'clerk@example.com')['expired']
    latest=client.post(f"/stores/gwangju/staff/invites/{body['id']}/reissue",headers=owner).json()['token']
    assert client.post(f"/stores/gwangju/staff/invites/{body['id']}/cancel",headers=owner).status_code==200
    assert accept(client,latest).status_code==400
    assert client.get('/stores/gwangju/staff',headers=owner).json()['staff'][0]['email']=='staff@hwagae.local'

def test_existing_account_is_attached_without_new_password(service):
    app,client,login=service
    owner=login()
    staff=login('staff@hwagae.local')
    response=invite(client,owner,email='staff@hwagae.local',store='busan',permissions=['inventory'])
    assert response.status_code==201 and response.json()=={'id':'demo-staff','existing_account':True,'invite':None}
    assert sorted(s['id'] for s in client.get('/stores',headers=staff).json()['stores'])==['busan','gwangju']
    assert login('staff@hwagae.local')
    assert invite(client,owner,email='staff@hwagae.local').status_code==409
    assert invite(client,owner,email='owner@hwagae.local').status_code==409
    assert invite(client,owner,email='operator@example.com').status_code==400
    assert invite(client,owner,email='not-an-email').status_code==422
    with app.state.database.connect() as db:
        assert db.execute("SELECT role FROM memberships WHERE user_id='demo-owner' AND store_id='gwangju'").fetchone()[0]=='owner'
        assert not db.execute("SELECT 1 FROM platform_operators WHERE user_id IN ('demo-staff','demo-owner')").fetchone()

def test_permissions_are_enforced_on_guarded_routes(service):
    _,client,login=service
    owner,staff=login(),login('staff@hwagae.local')
    sale={'rows':[{'date':today().isoformat(),'product_id':'P001','units_sold':4}]}
    product='/stores/gwangju/products/P001'
    settings={'price':4800,'cost':2600,'lead_days':1,'shelf_days':2,'review_days':1}
    # Existing staff keep the defaults: sales, inventory and drafts, but not products or confirmation.
    assert client.post('/stores/gwangju/sales',headers=staff,json=sale).status_code==201
    assert stock(client,staff).status_code==200
    order=draft(client,staff); assert order.status_code==201,order.text
    confirm=f"/stores/gwangju/orders/{order.json()['id']}/confirm"
    assert client.post(confirm,headers=staff).status_code==403
    assert client.patch(product,headers=staff,json=settings).status_code==403
    assert client.patch(product+'/availability',headers=staff,json={'active':False}).status_code==403
    member='/stores/gwangju/staff/members/demo-staff'
    result=client.patch(member,headers=owner,json={'permissions':['order_confirm','products','products']})
    assert result.status_code==200 and result.json()['permissions']==['order_confirm','products']
    assert client.get('/stores',headers=staff).json()['stores'][0]['permissions']==['order_confirm','products']
    assert client.post('/stores/gwangju/sales',headers=staff,json={'rows':[{'date':(today()-timedelta(days=100)).isoformat(),'product_id':'P001','units_sold':1}]}).status_code==403
    assert client.post('/stores/gwangju/sales/preview',headers=staff,files={'file':('s.csv',b'date,product_id,units_sold\n','text/csv')}).status_code==403
    assert stock(client,staff).status_code==403
    assert draft(client,staff).status_code==403
    assert client.patch(product,headers=staff,json=settings).status_code==200
    assert client.patch(product+'/availability',headers=staff,json={'active':True}).status_code==200
    order=draft(client,owner).json()
    path=f"/stores/gwangju/orders/{order['id']}"
    assert client.post(path+'/confirm',headers=staff).status_code==200
    assert client.get(path+'/export?format=csv',headers=staff).status_code==200
    # Owner-only work never becomes a staff permission.
    assert client.put('/stores/gwangju/forecast-settings',headers=staff,json={'provider':'weekday'}).status_code==403
    assert client.patch(member,headers=owner,json={'permissions':['owner']}).status_code==422

def test_staff_and_operator_cannot_manage_staff_and_owners_are_isolated(service):
    _,client,login=service
    owner,staff,operator=login(),login('staff@hwagae.local'),login('operator@example.com')
    member='/stores/gwangju/staff/members/demo-staff'
    for auth in (staff,operator):
        assert client.get('/stores/gwangju/staff',headers=auth).status_code==403
        assert invite(client,auth).status_code==403
        assert client.patch(member,headers=auth,json={'permissions':list(PERMISSIONS)}).status_code==403
        assert client.post(member+'/remove',headers=auth).status_code==403
    pending=invite(client,owner).json()['id']
    assert client.post(f'/stores/gwangju/staff/invites/{pending}/reissue',headers=staff).status_code==403
    # Another owner can neither see nor reach this store's staff, even through their own store.
    contract=client.post('/admin/contracts',headers=operator,json={'email':'other@example.com','merchant_name':'다른 점주','starts_on':today().isoformat(),'ends_on':(today()+timedelta(days=30)).isoformat()}).json()
    assert client.post('/auth/invitations/accept',json={'token':contract['invite']['token'],'password':PASSWORD}).status_code==201
    other=login('other@example.com',PASSWORD)
    own=client.post('/stores',headers=other,json={'name':'다른 매장','city':'서울','latitude':37.5,'longitude':127}).json()['id']
    assert client.get('/stores/gwangju/staff',headers=other).status_code==403
    assert invite(client,other,store='gwangju').status_code==403
    assert client.patch(f'/stores/{own}/staff/members/demo-staff',headers=other,json={'status':'suspended'}).status_code==404
    assert client.post(f'/stores/{own}/staff/invites/{pending}/cancel',headers=other).status_code==404
    assert client.patch(f'/stores/gwangju/staff/members/demo-owner',headers=owner,json={'status':'suspended'}).status_code==404
    assert client.get('/stores/gwangju/products',headers=staff).status_code==200

def test_suspend_reactivate_and_remove(service):
    _,client,login=service
    owner,staff=login(),login('staff@hwagae.local')
    member='/stores/gwangju/staff/members/demo-staff'
    assert client.patch(member,headers=owner,json={'status':'suspended'}).status_code==200
    assert client.get('/auth/me',headers=staff).status_code==401
    staff=login('staff@hwagae.local')
    assert client.get('/stores',headers=staff).json()['stores']==[]
    assert client.get('/stores/gwangju/products',headers=staff).status_code==403
    assert staff_row(client,owner,'staff@hwagae.local')['status']=='suspended'
    assert client.patch(member,headers=owner,json={'status':'active'}).status_code==200
    assert client.get('/stores/gwangju/products',headers=staff).status_code==200
    # With another active store the session survives; only the suspended store closes.
    assert invite(client,owner,email='staff@hwagae.local',store='busan').status_code==201
    assert client.patch(member,headers=owner,json={'status':'suspended'}).status_code==200
    assert [s['id'] for s in client.get('/stores',headers=staff).json()['stores']]==['busan']
    assert client.post(member+'/remove',headers=owner).status_code==200
    assert client.post(member+'/remove',headers=owner).status_code==404
    assert client.post('/stores/busan/staff/members/demo-staff/remove',headers=owner).status_code==200
    assert client.get('/auth/me',headers=staff).status_code==401
    staff=login('staff@hwagae.local')
    assert client.get('/stores',headers=staff).json()['stores']==[]
    assert all(row['email']!='staff@hwagae.local' for row in client.get('/stores/gwangju/staff',headers=owner).json()['staff'])

def test_existing_staff_get_default_permissions_on_migration(service):
    app,client,login=service
    with app.state.database.connect() as db:
        db.executescript('DROP TABLE staff_access; DROP TABLE staff_invites;')
    app.state.database.initialize()
    staff=login('staff@hwagae.local')
    assert client.get('/stores',headers=staff).json()['stores'][0]['permissions']==DEFAULT_PERMISSIONS
    with app.state.database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM sales WHERE store_id='gwangju'").fetchone()[0]==840
