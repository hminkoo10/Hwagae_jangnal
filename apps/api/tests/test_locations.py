import pytest
from fastapi.testclient import TestClient
from app.main import create_app

@pytest.fixture
def service(tmp_path):
    app=create_app(tmp_path/'locations.sqlite3')
    with TestClient(app) as client:
        token=client.post('/auth/login',json={'email':'owner@hwagae.local','password':'hwagae-demo'}).json()['token']
        yield app,client,{'Authorization':'Bearer '+token}

def test_search_auth_cache_coordinate_order_and_timezone(service):
    app,client,auth=service
    calls=[]
    def reader(kind,values):
        calls.append((kind,values))
        if kind=='search':
            return {'features':[{'geometry':{'coordinates':[-96.797,32.7767]},'properties':{'name':'Dallas','state':'Texas','country':'United States','osm_value':'city'}}]}
        return {'timezone':'America/Chicago'}
    app.state.location_reader=reader
    assert client.get('/locations/search?q=Dallas').status_code==401
    first=client.get('/locations/search?q=Dallas',headers=auth)
    assert first.status_code==200,first.text
    item=first.json()['results'][0]
    assert item['longitude']==-96.797 and item['latitude']==32.7767
    assert '확인' in item['precision']  # City centroids are never called exact store locations.
    assert client.get('/locations/search?q=Dallas',headers=auth).json()==first.json()
    assert len(calls)==1
    result=client.get('/locations/resolve?latitude=32.7767&longitude=-96.797',headers=auth)
    assert result.json()['timezone']=='America/Chicago'
    store=client.post('/stores',headers=auth,json={'name':'Dallas store','city':item['address'],**result.json()})
    assert store.status_code==201,store.text
    data=next(s for s in client.get('/stores',headers=auth).json()['stores'] if s['id']==store.json()['id'])
    assert data['timezone']=='America/Chicago' and data['weather_provider']=='noaa_gfs'

def test_location_bounds_empty_query_throttle_and_invalid_upstream(service):
    app,client,auth=service
    assert client.get('/locations/search?q=%20%20',headers=auth).status_code==400
    assert client.get('/locations/resolve?latitude=nan&longitude=127',headers=auth).status_code==422
    assert client.get('/locations/resolve?latitude=91&longitude=127',headers=auth).status_code==422
    app.state.location_reader=lambda *args:{'features':[]}
    assert client.get('/locations/search?q=first',headers=auth).status_code==200
    assert client.get('/locations/search?q=second',headers=auth).status_code==429
    app.state.location_reader=lambda *args:{'timezone':'not-a-timezone'}
    assert client.get('/locations/resolve?latitude=37&longitude=127',headers=auth).status_code==502
