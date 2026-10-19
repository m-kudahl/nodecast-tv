const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
for (const engine of ['chromium','webkit']) {
    test(`${engine} keeps mobile player controls visible and clickable through viewport changes`,
        { skip: process.env.NODECAST_BROWSER_TESTS === '1' ? false : 'Browser tests enabled in CI', timeout: 45000 }, async t => {
            const type=require('playwright')[engine],root=path.join(__dirname,'../public');
            const scripts=['/js/pages/WatchPage.js','/js/pages/SeriesPage.js'];
            const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*https:\/\/[^>]*>/gi,'');
            const server=http.createServer((req,res)=>{
                const name=new URL(req.url,'http://fixture').pathname;
                if(name==='/'){res.setHeader('Content-Type','text/html');res.end(html+scripts.map(src=>`<script src="${src}"></script>`).join(''));return;}
                if(name==='/css/main.css'||scripts.includes(name)){res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(root,name)));return;}
                res.writeHead(404);res.end();
            });
            await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
            t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
            const browser=await type.launch({headless:true,executablePath:engine==='chromium'?process.env.NODECAST_BROWSER_EXECUTABLE||undefined:undefined});t.after(()=>browser.close());
            const page=await browser.newPage({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 Version/26.3 Mobile/15E148 Safari/604.1'});
            const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(()=>{
                window.fullscreenClicks=0;window.PlayerFullscreen={toggle(){window.fullscreenClicks++;}};
                window.watch=new WatchPage({});
                for(const node of document.querySelectorAll('.page'))node.classList.remove('active');
                document.querySelector('#page-watch').classList.add('active');
            });
            for(const viewport of [{width:390,height:844},{width:390,height:640},{width:844,height:390},{width:568,height:256},{width:390,height:844}]){
                await page.setViewportSize(viewport);
                await page.waitForFunction(()=>{
                    const r=document.querySelector('.watch-video-section').getBoundingClientRect();
                    return r.bottom<=innerHeight+1;
                });
                const bounds=await page.evaluate(()=>{
                    const r=document.querySelector('#watch-fullscreen').getBoundingClientRect();
                    const point=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
                    return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,h:innerHeight,w:innerWidth,hit:point?.closest('button')?.id};
                });
                assert.ok(bounds.top>=0&&bounds.bottom<=bounds.h&&bounds.left>=0&&bounds.right<=bounds.w,JSON.stringify(bounds));
                assert.equal(bounds.hit,'watch-fullscreen');await page.locator('#watch-fullscreen').click();
            }
            assert.equal(await page.evaluate(()=>window.fullscreenClicks),5);
            // Current WebKit series rendering is checked, but does not establish Safari 26.3's report as fixed.
            await page.evaluate(async()=>{
                document.querySelector('#page-watch').classList.remove('active');document.querySelector('#page-series').classList.add('active');
                window.Icons={chevronDown:'v'};window.API={proxy:{xtream:{seriesInfo:async()=>({episodes:{1:[{id:'1',episode_num:1,title:'Fixture Episode'}]}})}}};
                const series=new SeriesPage({});await series.showSeriesDetails({series_id:1,sourceId:1,name:'Fixture'});
            });
            await page.locator('.episode-item').scrollIntoViewIfNeeded();assert.equal(await page.locator('.episode-item').isVisible(),true);
            assert.deepEqual(errors,[]);await page.close();
        });
}
