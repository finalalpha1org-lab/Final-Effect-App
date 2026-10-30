#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {
using namespace fe;
constexpr uint32_t CAP=513u*513u;
/* Streamed chunks cap at 128 segments, so their grids are 129x129. */
#define FE_GRID_MAX_ROW 129u
static float H[CAP], normals[CAP*3], colors[CAP*3], weights[3][CAP*4], scratch[CAP];
static uint8_t masks[CAP*4], materials[CAP];
static float forestInput[32768*3];
static float scatterOut[16384*4];
static int32_t forestOutput[32768];
static uint32_t N=128,W=129;
static float size=100;
float hash(int x,int z,uint32_t s){uint32_t h=uint32_t(x)*374761393u+uint32_t(z)*668265263u+s*1442695041u;h=(h^(h>>13))*1274126177u;return float(h^(h>>16))/4294967296.f;}
float noise(float x,float z,uint32_t s){int i=int(floorf(x)),j=int(floorf(z));float a=x-i,b=z-j;a=a*a*(3-2*a);b=b*b*(3-2*b);return lerpf(lerpf(hash(i,j,s),hash(i+1,j,s),a),lerpf(hash(i,j+1,s),hash(i+1,j+1,s),a),b);}
float sample(const float* h,float x,float z){float u=clampf((x/size+.5f)*N,0,float(N)-.0001f),v=clampf((z/size+.5f)*N,0,float(N)-.0001f);uint32_t i=uint32_t(u),j=uint32_t(v),k=j*W+i;return lerpf(lerpf(h[k],h[k+1],u-i),lerpf(h[k+W],h[k+W+1],u-i),v-j);}
bool finite(float x){return isfinitef(x);}

/* --- C++ terrain surface/colour kernel (JS feeds weights; C++ shades) --- */
float gPal[8*3]={.28f,.5f,.16f,.42f,.29f,.17f,.42f,.42f,.44f,.64f,.56f,.38f,.92f,.94f,.98f,.13f,.13f,.14f,.5f,.5f,.5f,.5f,.5f,.5f};
uint32_t gPalCount=5,gPaintCount=12,gNoiseSeed=1,gDesert=0;
uint8_t gPaintRGB[16*3]={0};
float gSeed=0,gWater=0,gRock=1.3f,gSnow=16;

float layeredHeight(float x,float z,float seed,float hs,uint32_t s){
 const float wx=(noise(x*.012f+seed*.13f+41,z*.012f+seed*.07f+13,s)-.5f)*10;
 const float wz=(noise(x*.012f+seed*.03f+17,z*.012f+seed*.17f+61,s)-.5f)*10;
 float n=0,a=.56f,f=.026f;
 for(int o=0;o<4;o++){n+=(noise((x+wx)*f+(float)o*17,(z+wz)*f+(float)o*11,s)-.5f)*a;a*=.5f;f*=2.05f;}
 float ridge=0,ra=.55f,rf=.035f;
 for(int o=0;o<4;o++){const float q=noise((x+wx*.4f)*rf+31+(float)o*7,(z+wz*.4f)*rf-17,s);ridge+=(1-absf(q*2-1))*ra;ra*=.5f;rf*=2.05f;}
 ridge=ridge/1.03125f-.5f;
 return n*hs*1.65f+ridge*hs*.6f;
}
float continentalMountain(float x,float z,float seed,float mountain,uint32_t s){
 const float r=sqrtf(x*x+z*z);
 float m=0,a=.55f,f=.0019f;
 for(int o=0;o<4;o++){const float q=noise(x*f+seed*.21f+(float)o*13,z*f-seed*.11f,s);m+=(1-absf(q*2-1))*a;a*=.5f;f*=2.1f;}
 m/=1.03125f;
 return mountain*powf(m,1.6f)*190.f*smoothstepf(15,420,r);
}
void mixInto(float& r,float& g,float& b,float tr,float tg,float tb,float t){
 r=lerpf(r,tr,t);g=lerpf(g,tg,t);b=lerpf(b,tb,t);
}
/* sRGB 0-1 to linear light, the same curve the JS palette conversion uses. */
static inline float srgbToLinear(float c){
 if(c<=.04045f)return c*(1.f/12.92f);
 const float x=(c+.055f)*(1.f/1.055f);
 return x*x*powf(x,.4f); /* x^2.4 */
}
void terrainColorAt(uint32_t i,uint32_t j){
 const uint32_t k=j*W+i;const float h=H[k];
 /* Rise over run over a 3 m central window, not the sum of two one-cell
    deltas: the old form made every noisy cell a cliff, so over half the
    island was painted rock and soil instead of grass. 1.0 is 45 deg. */
 const float cell=size/float(N);
 const uint32_t i0=i>2?i-2:0,i1=i+2<N?i+2:N,j0=j>2?j-2:0,j1=j+2<N?j+2:N;
 const float gx=(H[j*W+i1]-H[j*W+i0])/maxf(float(i1-i0)*cell,1e-4f);
 const float gz=(H[j1*W+i]-H[j0*W+i])/maxf(float(j1-j0)*cell,1e-4f);
 const float sl=sqrtf(gx*gx+gz*gz);
 float total=0;for(int c=0;c<3;c++)for(int q=0;q<4;q++)total+=weights[c][k*4+q];
 float r=0,g=0,b=0;
 /* The ground comes first, then the paint is laid over it - in that order,
   because a painted cell still has ground underneath it. The old order tested
   the paint first and let it replace the palette outright, normalised by
   `total`, so a cell carrying 3% of a brush still rendered the full paint
   colour: every stroke had a pen-sharp rim on virgin ground and no soft edge
   at all. Coverage is the mix weight now. */
 if(materials[k]!=255){
  const uint32_t p=(materials[k]<gPalCount?materials[k]:0)*3;r=gPal[p];g=gPal[p+1];b=gPal[p+2];
 }else{
  const uint32_t s=gNoiseSeed;
  const float broad=noise(i*.045f+gSeed*.09f,j*.045f-gSeed*.12f,s);
  const float mid=noise(i*.14f+gSeed*.23f,j*.14f-gSeed*.31f,s);
  const float fine=noise(i*.36f-gSeed*.17f,j*.36f+gSeed*.31f,s);
  const float field=broad*.56f+mid*.3f+fine*.14f;
  const float ground=smoothstepf(.4f,.68f,field+clampf((h-12)*.002f,-.03f,.03f));
  r=lerpf(gPal[0],gPal[3],ground*.34f);g=lerpf(gPal[1],gPal[4],ground*.34f);b=lerpf(gPal[2],gPal[5],ground*.34f);
  const float rockThreshold=gRock+(broad-.5f)*.5f+(mid-.5f)*.25f;
  const float cliff=smoothstepf(rockThreshold-.25f,rockThreshold+1.15f,sl);
  const float outcrop=smoothstepf(.72f,.9f,field)*.25f;
  const float rock=clampf(cliff*.88f+outcrop*(1-cliff*.65f),0,1);
  mixInto(r,g,b,gPal[6],gPal[7],gPal[8],rock);
  const float shore=1-smoothstepf(gWater-.35f+(broad-.5f)*.6f,gWater+1.55f+(broad-.5f)*1.3f,h);
  const float dune=gDesert?smoothstepf(.46f,.69f,field)*(1-cliff*.8f):0.f;
  const float sand=clampf(maxf(shore,dune)*(1-cliff*.6f),0,1);
  mixInto(r,g,b,gPal[9],gPal[10],gPal[11],sand);
  const float snowNoise=(broad-.5f)*6+(mid-.5f)*3+(fine-.5f)*1.5f;
  const float snow=smoothstepf(gSnow-1.2f+snowNoise,gSnow+3.4f+snowNoise,h)*(1-cliff*.25f);
  mixInto(r,g,b,gPal[12],gPal[13],gPal[14],snow);
  const float variation=.9f+.18f*broad+.08f*(mid-.5f)+.06f*(fine-.5f)+.04f*(hash(int(i),int(j*7),s)-.5f);
  r*=variation;g*=variation;b*=variation;
 }
 if(total>.001f){
  float pr=0,pg=0,pb=0;
  for(uint32_t q=0;q<gPaintCount&&q<12;q++){
   const float w=q<4?weights[0][k*4+q]:q<8?weights[1][k*4+q-4]:weights[2][k*4+q-8];
   /* Paint is chosen as an sRGB swatch and the buffer is linear light, exactly
      like the palette. Handing the swatch straight over made every painted
      patch about a stop and a half brighter than the ground it covered, which
      reads as a glowing blob with a hard edge - the other half of what
      "painting leaves artifacts" looked like. */
   pr+=srgbToLinear(gPaintRGB[q*3]*(1.f/255.f))*w;
   pg+=srgbToLinear(gPaintRGB[q*3+1]*(1.f/255.f))*w;
   pb+=srgbToLinear(gPaintRGB[q*3+2]*(1.f/255.f))*w;
  }
  pr/=total;pg/=total;pb/=total;
  /* A brush edge lands partly on a cell: that is coverage, not a switch. */
  mixInto(r,g,b,pr,pg,pb,clampf(total,0.f,1.f));
 }
 const float v=.94f+.12f*hash(int(i*3),int(j*7),gNoiseSeed);
 colors[k*3]=r*v;colors[k*3+1]=g*v;colors[k*3+2]=b*v;
}

/* --- Hydraulic erosion, split across frames -------------------------------
   The droplet loop below is the one the batch call uses. Splitting it changes
   only how many droplets run per call: a droplet finishes before the next one
   starts and draws exactly two random numbers at birth, so the same seed split
   into 700 + 700 + ... droplets erodes the field *bit-identically* to one call
   of the whole count. That equality is a test in tests/landscape-cpp.test.mjs,
   not an assumption.

   The run also reports the cells it touched. The rectangle carries a one-cell
   halo because a height change moves the normals of its neighbours too, and the
   caller uploads exactly that rectangle instead of the whole heightfield. */
struct ErosionParams{uint32_t lifetime;float inertia,capacity,erode,deposit,evap,gravity;
  /* Spawn / clip box, a square of half-width `radius` around (cx, cz). radius
     <= 0 means the whole map, which is what the batch call uses and what makes
     a live run bit-identical to it. A bounded patch is how live erosion stays
     cheap: rain outside the patch is not simulated, so nothing outside it can
     change and the uploaded rectangle stays small. */
  float cx,cz,radius;};
static ErosionParams eroParams{64,.05f,.3f,.3f,.3f,.01f,4.f,0,0,0};
static uint32_t eroRng=1,eroTotal=0,eroLeft=0;
static bool eroActive=false;
static uint16_t eroRect[4]={0xFFFF,0xFFFF,0,0};   /* min_i, min_j, max_i, max_j — empty when min_i > max_i */
static void eroResetRect(){eroRect[0]=0xFFFF;eroRect[1]=0xFFFF;eroRect[2]=0;eroRect[3]=0;}
static void eroTouch(int32_t i,int32_t j){
  if(i<0)i=0;else if(i>int32_t(N))i=int32_t(N);
  if(j<0)j=0;else if(j>int32_t(N))j=int32_t(N);
  const uint16_t u=uint16_t(i),v=uint16_t(j);
  if(u<eroRect[0])eroRect[0]=u;
  if(v<eroRect[1])eroRect[1]=v;
  if(u>eroRect[2])eroRect[2]=u;
  if(v>eroRect[3])eroRect[3]=v;
}
static void eroCancelRun(){eroActive=false;eroLeft=0;eroResetRect();}
static uint32_t eroRun(uint32_t count,uint32_t& rng,const ErosionParams& p){
  const float cell=size/N;
  auto random=[&](){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return float(rng)/4294967296.f;};
  const bool bounded=p.radius>0.f;
  auto splat=[&](float x,float z,float amount){
    float m=1.f;
    if(bounded){
      const float off=maxf(absf(x-p.cx),absf(z-p.cz));
      if(off>p.radius)return;
      /* Feathered over the outer quarter of the patch, so a live run does not
         leave a square wall where the simulated rain stops. */
      m=1.f-smoothstepf(p.radius*.72f,p.radius,off);
      amount*=m;
    }
    const float u=clampf((x/size+.5f)*N,0,float(N)-.001f),v=clampf((z/size+.5f)*N,0,float(N)-.001f);
    const uint32_t i=uint32_t(u),j=uint32_t(v),k=j*W+i;const float a=u-i,b=v-j;
    H[k]+=amount*(1-a)*(1-b);H[k+1]+=amount*a*(1-b);H[k+W]+=amount*(1-a)*b;H[k+W+1]+=amount*a*b;
    /* the 2x2 cells that changed, grown by one so their normals are rebuilt too */
    eroTouch(int32_t(i)-1,int32_t(j)-1);eroTouch(int32_t(i)+2,int32_t(j)+2);
  };
  for(uint32_t d=0;d<count;d++){
    /* Two draws per droplet either way, so bounding the patch does not change
       how many numbers a droplet consumes. */
    const float rx=random(),rz=random();
    float x=bounded?p.cx+(rx-.5f)*2.f*p.radius:(rx-.5f)*size;
    float z=bounded?p.cz+(rz-.5f)*2.f*p.radius:(rz-.5f)*size;
    float dx=0,dz=0,speed=1,water=1,sediment=0;
    for(uint32_t life=0;life<p.lifetime;life++){
      const float h=sample(H,x,z);
      const float gx=(sample(H,x+cell,z)-sample(H,x-cell,z))/(2*cell);
      const float gz=(sample(H,x,z+cell)-sample(H,x,z-cell))/(2*cell);
      dx=dx*p.inertia-gx*(1-p.inertia);dz=dz*p.inertia-gz*(1-p.inertia);
      const float length=sqrtf(dx*dx+dz*dz);
      if(length<.000001f)break;
      dx/=length;dz/=length;
      const float nx=x+dx*cell,nz=z+dz*cell;
      if(nx<=-size*.5f||nx>=size*.5f||nz<=-size*.5f||nz>=size*.5f)break;
      if(bounded&&maxf(absf(nx-p.cx),absf(nz-p.cz))>p.radius)break;
      const float dh=sample(H,nx,nz)-h;
      const float capacity=maxf(-dh*speed*water*p.capacity,.01f);
      if(sediment>capacity||dh>0){
        const float amount=dh>0?minf(dh,sediment):(sediment-capacity)*p.deposit;
        splat(x,z,amount);sediment-=amount;
      }else{
        float amount=minf((capacity-sediment)*p.erode,-dh);
        amount=minf(amount,cell*.5f);
        splat(x,z,-amount);sediment+=amount;
      }
      speed=sqrtf(maxf(speed*speed-dh*p.gravity,0));
      water*=(1-p.evap);
      x=nx;z=nz;
      if(water<.01f)break;
    }
  }
  return count;
}
}
extern "C" {
float* fe_forest_input_ptr(){return forestInput;}
int32_t* fe_forest_output_ptr(){return forestOutput;}
int32_t fe_forest_classify(uint32_t count,float cx,float cz,float nearDist,float farDist){
 if(count>32768||!finite(cx)||!finite(cz)||!finite(nearDist)||!finite(farDist)||nearDist<0||farDist<nearDist)return -1;
 for(uint32_t i=0;i<count;i++){
  const float x=forestInput[i*3],z=forestInput[i*3+1],r=forestInput[i*3+2];
  if(!finite(x)||!finite(z)||!finite(r)||absf(r)>1000000){forestOutput[i]=-1;continue;}
  const float dx=cx-x,dz=cz-z,d2=dx*dx+dz*dz;
  if(d2>farDist*farDist){forestOutput[i]=-1;continue;}
  if(d2<=nearDist*nearDist){forestOutput[i]=-2;continue;}
  const float a=fe::atan2f(dx,dz);
  const float q=(a-r)/1.570796327f;
  // Match JS Math.round including negative half-turn ties.
  const int v=int(floorf(q+.5f));forestOutput[i]=((v%4)+4)%4;
 }
 return int32_t(count);
}
float* fe_terrain_scatter_out_ptr(){return scatterOut;}
int32_t fe_terrain_scatter_batch(uint32_t count,float spread,uint32_t seed){
 if(count<1||count>16384)return -1;
 if(!finite(spread)||spread<=0||spread>100000)return -1;
 uint32_t rng=seed?seed:0x9e3779b9u;
 auto random=[&](){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return float(rng)/4294967296.f;};
 /* Jittered grid: every batch covers the span evenly instead of clumping the
    way pure uniform sampling does at these counts. */
 const uint32_t grid=uint32_t(sqrtf(float(count))+.5f);
 for(uint32_t i=0;i<count;i++){
  const float x=((float(i%grid)+random())*spread/float(grid))-spread*.5f;
  const float z=((float(i/grid)+random())*spread/float(grid))-spread*.5f;
  const float y=sample(H,x,z);
  const float hx=(sample(H,x+1,z)-sample(H,x-1,z))*.5f;
  const float hz=(sample(H,x,z+1)-sample(H,x,z-1))*.5f;
  scatterOut[i*4]=x;scatterOut[i*4+1]=z;scatterOut[i*4+2]=y;
  scatterOut[i*4+3]=sqrtf(hx*hx+hz*hz);
 }
 return int32_t(count);
}
/* Terrain-aware scatter candidates for ground cover: rejection-samples the
   resident heightfield so candidates already respect the water margin and the
   species slope limit, then thins them with a patch (clump) field. This keeps
   the JS-side instance rules as the authority while giving the expensive cover
   budgets (tens of thousands of grass/flowers) a natural patch structure
   instead of a uniform square grid. */
int32_t fe_terrain_scatter_natural(uint32_t count,float spread,uint32_t seed,
                                   float water_level,float max_slope,
                                   float clump,float patch_scale){
 if(count<1||count>16384)return -1;
 if(!finite(spread)||spread<=0||spread>100000)return -1;
 if(!finite(water_level)||water_level<-5000||water_level>5000)return -1;
 if(!finite(max_slope)||max_slope<=0||max_slope>50)return -1;
 if(!finite(clump)||clump<0||clump>1)return -1;
 if(!finite(patch_scale)||patch_scale<.5f||patch_scale>200)return -1;
 uint32_t rng=seed?seed:0x9e3779b9u;
 auto random=[&](){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return float(rng)/4294967296.f;};
 uint32_t made=0,attempt=0;
 const uint32_t maxAttempts=count*16u;
 while(made<count&&attempt<maxAttempts){
  attempt++;
  const float x=(random()-.5f)*spread,z=(random()-.5f)*spread;
  const float y=sample(H,x,z);
  if(y<water_level+.25f)continue;
  const float hx=(sample(H,x+1,z)-sample(H,x-1,z))*.5f;
  const float hz=(sample(H,x,z+1)-sample(H,x,z-1))*.5f;
  const float sl=sqrtf(hx*hx+hz*hz);
  if(sl>max_slope)continue;
  if(clump>0.f){
   const float cn=noise(x/patch_scale+float(seed%97)*.37f,z/patch_scale-float(seed%53)*.21f,seed);
   const float t=clampf((cn-.32f)/.36f,0.f,1.f);
   const float keep=(1.f-clump)+clump*t*t*(3.f-2.f*t);
   if(random()>keep)continue;
  }
  scatterOut[made*4]=x;scatterOut[made*4+1]=z;
  scatterOut[made*4+2]=y;scatterOut[made*4+3]=sl;
  made++;
 }
 return int32_t(made);
}
int32_t fe_terrain_apply_strata(float strata_height,float strata_strength,float tilt_x,float tilt_z,float warp_amp){
 if(!finite(strata_height)||strata_height<.05f||strata_height>500)return -1;
 if(!finite(strata_strength)||strata_strength<=0||strata_strength>1)return -1;
 if(!finite(tilt_x)||tilt_x<-10||tilt_x>10||!finite(tilt_z)||tilt_z<-10||tilt_z>10)return -1;
 if(!finite(warp_amp)||warp_amp<0||warp_amp>200)return -1;
 for(uint32_t j=0;j<W;j++)for(uint32_t i=0;i<W;i++){
  const uint32_t k=j*W+i;
  const float x=(float(i)/N-.5f)*size,z=(float(j)/N-.5f)*size;
  const float warp=(noise(x*.018f+11,z*.018f-7,gNoiseSeed)-.5f)*2.f*warp_amp;
  const float band=(H[k]+x*tilt_x+z*tilt_z+warp)/strata_height;
  const float t=band-floorf(band);
  const float ledge=(floorf(band)+.5f)*strata_height-(x*tilt_x+z*tilt_z+warp);
  /* Strongest pull in the middle of a band, zero at band edges, so terraces
     blend into the slope instead of tearing a step discontinuity. */
  H[k]=lerpf(H[k],ledge,strata_strength*(1.f-absf(t-.5f)*1.2f));
 }
 return 0;
}
uint32_t fe_landscape_backend_magic(){return FE_LANDSCAPE_CPP_MAGIC;}
/* Resetting the grid is one pass over every array the kernels write, and it
   runs whenever the resolution or the span changes. It used to be a single
   loop over the cells with three c-branches and five different strides inside,
   which no vectoriser can see through -- at 513x513 that is 20 MB of scattered
   stores. Split per array so each one is a straight run the backend can widen;
   the values are identical, cell for cell. */
int32_t fe_terrain_init(uint32_t n,float span){
 if(n<16||n>512||!finite(span)||span<=0)return -1;
 eroCancelRun();N=n;W=n+1;size=span;
 const uint32_t cells=W*W, attrs=cells*3;
 for(uint32_t k=0;k<cells;k++){H[k]=0.f;materials[k]=255;}
 for(uint32_t k=0;k<attrs;k+=3){normals[k]=0.f;normals[k+1]=1.f;normals[k+2]=0.f;}
 for(uint32_t k=0;k<attrs;k++)colors[k]=.5f;
 /* weights[3][CAP*4] is one contiguous block, so the three layers clear as a
    single run of cells*12 floats. */
 float* const w=&weights[0][0];
 for(uint32_t k=0;k<cells*12;k++)w[k]=0.f;
 for(uint32_t k=0;k<cells*4;k++)masks[k]=0;
 return 0;
}
uint32_t fe_terrain_get_segments(){return N;}
uint32_t fe_terrain_get_grid_width(){return W;}
float* fe_terrain_get_height_ptr(){return H;}
float* fe_terrain_get_normal_ptr(){return normals;}
float* fe_terrain_get_color_ptr(){return colors;}
uint8_t* fe_terrain_get_splat_rgba_ptr(){return masks;}
uint8_t* fe_terrain_get_mat_index_ptr(){return materials;}
float* fe_terrain_get_surf_weights_a_ptr(){return weights[0];}
float* fe_terrain_get_surf_weights_b_ptr(){return weights[1];}
float* fe_terrain_get_surf_weights_c_ptr(){return weights[2];}
float fe_terrain_sample_height(float x,float z){return finite(x)&&finite(z)?sample(H,x,z):0;}
void fe_terrain_sample_normal(float x,float z,float alignment,float* out){if(!out)return;float d=size/N;Vec3 n=normalize(Vec3((sample(H,x-d,z)-sample(H,x+d,z))*alignment,2*d,(sample(H,x,z-d)-sample(H,x,z+d))*alignment));out[0]=n.x;out[1]=n.y;out[2]=n.z;}
int32_t fe_terrain_generate_gaea(float seed,uint32_t mode,float height,float sharp,float warp,float strata,float freq,uint32_t continental,float base,float mountain){if(!finite(seed)||!finite(height)||!finite(sharp)||!finite(warp)||!finite(strata)||!finite(freq)||!finite(base)||!finite(mountain)||mode>5)return -1;uint32_t s=uint32_t(absf(seed));for(uint32_t j=0;j<W;j++)for(uint32_t i=0;i<W;i++){float x=(float(i)/N-.5f)*size,z=(float(j)/N-.5f)*size;float wx=(noise(x*.012f,z*.012f,s)-.5f)*warp,wz=(noise(x*.012f+43,z*.012f-17,s)-.5f)*warp;float a=.5f,f=.026f,h=0,r=0;for(int o=0;o<6;o++){float n=noise((x+wx)*f,(z+wz)*f,s+o*17);h+=(n-.5f)*a;r+=powf(1-absf(n*2-1),clampf(sharp,.2f,8))*a;a*=.5f;f*=2.03f;}h=(h*1.6f+r*(mode==1?1.2f:.6f)-.25f)*height;if(mode==4){float q=sqrtf(x*x+z*z)/size;h+=height*(expf(-q*q*35)-.7f*expf(-q*q*240));}if(mode==2||mode==5)h=lerpf(h,floorf(h/maxf(freq,.1f))*maxf(freq,.1f),clampf(strata,0,1));if(!continental){float edge=smoothstepf(.62f,.98f,maxf(absf(x),absf(z))/(size*.5f));h=lerpf(h,-14,edge);}H[j*W+i]=h+base+mountain*r;materials[j*W+i]=255;}return 0;}
int32_t fe_terrain_rebuild_region(uint32_t x0,uint32_t x1,uint32_t z0,uint32_t z1,float seed,float water,float rock,float snow,uint32_t biome,const float* pal){(void)seed;(void)biome;if(!pal||x0>x1||z0>z1||x1>N||z1>N)return -1;float d=size/N;for(uint32_t j=z0;j<=z1;j++)for(uint32_t i=x0;i<=x1;i++){uint32_t k=j*W+i;float gx=(H[j*W+(i<N?i+1:i)]-H[j*W+(i?i-1:i)])/(d*(i&&i<N?2:1)),gz=(H[(j<N?j+1:j)*W+i]-H[(j?j-1:j)*W+i])/(d*(j&&j<N?2:1));Vec3 n=normalize(Vec3(-gx,1,-gz));normals[k*3]=n.x;normals[k*3+1]=n.y;normals[k*3+2]=n.z;uint32_t m=materials[k]!=255?materials[k]:H[k]<water+1?3:H[k]>snow?4:sqrtf(gx*gx+gz*gz)>rock?2:0;if(m>5)m=0;float total=0;for(int c=0;c<3;c++)for(int q=0;q<4;q++)total+=weights[c][k*4+q];for(int c=0;c<3;c++)colors[k*3+c]=pal[m*3+c];float avg=(H[j*W+(i?i-1:i)]+H[j*W+(i<N?i+1:i)]+H[(j?j-1:j)*W+i]+H[(j<N?j+1:j)*W+i])*.25f;masks[k*4+3]=uint8_t(clampf((avg-H[k])/d*.5f+.5f,0,1)*255);(void)total;}return 0;}
/* Smooth normals for any square height grid the studio streams in. Open-world
   chunks are rebuilt on every brush stroke, and three's computeVertexNormals
   allocates a fresh array and averages face normals; this is the same
   central-difference normal the root terrain uses, so a chunk shades exactly
   like the world it belongs to. Heights come from the caller's copy in
   gridHeights, normals go out in gridNormals. */
static float gridHeights[FE_GRID_MAX_ROW*FE_GRID_MAX_ROW];
static float gridNormals[FE_GRID_MAX_ROW*FE_GRID_MAX_ROW*3];
float* fe_grid_height_ptr(){return gridHeights;}
float* fe_grid_normal_ptr(){return gridNormals;}
int32_t fe_grid_normals(uint32_t row,float step){
 if(row<2||row>FE_GRID_MAX_ROW||!finite(step)||step<=0)return -1;
 const uint32_t last=row-1;
 for(uint32_t j=0;j<row;j++)for(uint32_t i=0;i<row;i++){
  const float gx=(gridHeights[j*row+(i<last?i+1:i)]-gridHeights[j*row+(i?i-1:i)])/(step*(i&&i<last?2:1));
  const float gz=(gridHeights[(j<last?j+1:j)*row+i]-gridHeights[(j?j-1:j)*row+i])/(step*(j&&j<last?2:1));
  const Vec3 n=normalize(Vec3(-gx,1,-gz));
  const uint32_t k=(j*row+i)*3;
  gridNormals[k]=n.x;gridNormals[k+1]=n.y;gridNormals[k+2]=n.z;
 }
 return 0;
}
void fe_terrain_compute_normals(){
 const float d=size/N;
 for(uint32_t j=0;j<W;j++)for(uint32_t i=0;i<W;i++){
  const float gx=(H[j*W+(i<N?i+1:i)]-H[j*W+(i?i-1:i)])/(d*(i&&i<N?2:1));
  const float gz=(H[(j<N?j+1:j)*W+i]-H[(j?j-1:j)*W+i])/(d*(j&&j<N?2:1));
  const Vec3 n=normalize(Vec3(-gx,1,-gz));const uint32_t k=(j*W+i)*3;
  normals[k]=n.x;normals[k+1]=n.y;normals[k+2]=n.z;
 }
}
/* Normals for one rectangle. The live erosion uploads this band and nothing
   else, so the normal formula must stay identical to fe_terrain_compute_normals()
   cell for cell — a test compares the two. */
int32_t fe_terrain_compute_normals_region(uint32_t x0,uint32_t x1,uint32_t z0,uint32_t z1){
 if(x0>x1||z0>z1||x1>N||z1>N)return -1;
 const float d=size/N;
 for(uint32_t j=z0;j<=z1;j++)for(uint32_t i=x0;i<=x1;i++){
  const float gx=(H[j*W+(i<N?i+1:i)]-H[j*W+(i?i-1:i)])/(d*(i&&i<N?2:1));
  const float gz=(H[(j<N?j+1:j)*W+i]-H[(j?j-1:j)*W+i])/(d*(j&&j<N?2:1));
  const Vec3 n=normalize(Vec3(-gx,1,-gz));const uint32_t k=(j*W+i)*3;
  normals[k]=n.x;normals[k+1]=n.y;normals[k+2]=n.z;
 }
 return int32_t((x1-x0+1)*(z1-z0+1));
}
int32_t fe_terrain_erode_brush(float px,float pz,float radius,float strength,float seed){
 if(!finite(px)||!finite(pz)||!finite(radius)||!finite(strength)||!finite(seed)||radius<=0||strength<0||strength>10||absf(seed)>1000000)return -1;
 uint32_t rng=uint32_t(absf(seed)*1000)+12345u;
 auto random=[&](){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return float(rng)/4294967296.f;};
 const float d=size/N;
 auto bump=[&](float x,float z,float amount){float u=clampf((x/size+.5f)*N,0,float(N)-.001f),v=clampf((z/size+.5f)*N,0,float(N)-.001f);uint32_t i=uint32_t(u),j=uint32_t(v),k=j*W+i;float a=u-i,b=v-j;H[k]+=amount*(1-a)*(1-b);H[k+1]+=amount*a*(1-b);H[k+W]+=amount*(1-a)*b;H[k+W+1]+=amount*a*b;};
 const uint32_t count=uint32_t(floorf(30+90*strength+.5f));
 for(uint32_t q=0;q<count;q++){float a=random()*6.2831853f,r=sqrtf(random())*radius,x=px+cosf(a)*r,z=pz+sinf(a)*r,vx=0,vz=0,sed=0,sp=1;
  for(int t=0;t<32;t++){if(absf(x)>size*.5f-d*.5f||absf(z)>size*.5f-d*.5f)break;
   const float h=sample(H,x,z),gx=(sample(H,x+d,z)-sample(H,x-d,z))/(2*d),gz=(sample(H,x,z+d)-sample(H,x,z-d))/(2*d);
   vx=vx*.5f-gx;vz=vz*.5f-gz;float length=sqrtf(vx*vx+vz*vz);if(length<.0001f)break;vx/=length;vz/=length;
   const float nx=x+vx*d,nz=z+vz*d,dh=sample(H,nx,nz)-h,capacity=maxf(-dh,.03f)*sp*6;
   if(sed>capacity||dh>0){float m=dh>0?minf(dh,sed):(sed-capacity)*.3f;bump(x,z,m);sed-=m;}
   else {float m=minf((capacity-sed)*.3f,-dh);bump(x,z,-m*.5f);sed+=m*.5f;}
   sp=sqrtf(maxf(sp*sp-dh*2,.05f));x=nx;z=nz;
  }
 }
 return int32_t(count);
}
int32_t fe_terrain_brush_stroke(uint32_t tool,float ax,float az,float bx,float bz,float radius,float strength,float dt,float target,uint32_t paint,uint32_t pbr,float seed,uint32_t* rect){if(tool==5||tool==6)return -2;if(tool>10||!finite(ax)||!finite(az)||!finite(bx)||!finite(bz)||!finite(radius)||radius<=0||!finite(strength)||!finite(dt)||dt<0||!finite(target)||!rect)return -1;(void)seed;float d=size/N;uint32_t x0=uint32_t(clampf(floorf((minf(ax,bx)-radius)/d+N*.5f),0,N)),x1=uint32_t(clampf(ceilf((maxf(ax,bx)+radius)/d+N*.5f),0,N)),z0=uint32_t(clampf(floorf((minf(az,bz)-radius)/d+N*.5f),0,N)),z1=uint32_t(clampf(ceilf((maxf(az,bz)+radius)/d+N*.5f),0,N));for(uint32_t j=z0?z0-1:0;j<=minf(N,z1+1);j++)for(uint32_t i=x0?x0-1:0;i<=minf(N,x1+1);i++)scratch[j*W+i]=H[j*W+i];float dx=bx-ax,dz=bz-az,l=dx*dx+dz*dz;int changed=0;for(uint32_t j=z0;j<=z1;j++)for(uint32_t i=x0;i<=x1;i++){float x=i*d-size*.5f,z=j*d-size*.5f,t=l>0?clampf(((x-ax)*dx+(z-az)*dz)/l,0,1):0,rx=x-ax-t*dx,rz=z-az-t*dz,q=(rx*rx+rz*rz)/(radius*radius);if(q>=1)continue;float f=(1-q)*(1-q),a=clampf(f*strength*dt*10,0,1);uint32_t k=j*W+i;float old=scratch[k];if(tool==0)H[k]+=f*strength*dt*10;else if(tool==1)H[k]-=f*strength*dt*10;else if(tool==2||tool==9)H[k]=lerpf(old,target,a);else if(tool==3){float avg=(scratch[j*W+(i?i-1:i)]+scratch[j*W+(i<N?i+1:i)]+scratch[(j?j-1:j)*W+i]+scratch[(j<N?j+1:j)*W+i])*.25f;H[k]=lerpf(old,avg,a);}else if(tool==4)H[k]=lerpf(old,floorf(old/3+.5f)*3,a);else if(tool==7)H[k]+=f*strength*dt*10*(1-q);else if(tool==8)H[k]+=(noise(x,z,uint32_t(absf(seed)))-.5f)*a;else if(tool==10){if(pbr&&paint<12){for(int c=0;c<3;c++)for(int v=0;v<4;v++)weights[c][k*4+v]*=1-a;weights[paint/4][k*4+paint%4]+=a;materials[k]=255;}else materials[k]=uint8_t(paint<6?paint:0);}changed++;}rect[0]=x0?x0-1:0;rect[1]=x1<N?x1+1:N;rect[2]=z0?z0-1:0;rect[3]=z1<N?z1+1:N;return changed;}
int32_t fe_terrain_set_palette(const float* pal,uint32_t count,float seed,float water,float rock,float snow,uint32_t desert){
 if(!pal||count<1||count>8||!finite(seed)||!finite(water)||!finite(rock)||!finite(snow))return -1;
 gPalCount=count;for(uint32_t k=0;k<count*3;k++)gPal[k]=pal[k];
 gSeed=seed;gWater=water;gRock=rock;gSnow=snow;gDesert=desert;
 gNoiseSeed=(uint32_t(absf(seed)*1000.f))^0x51ed270bu;return 0;
}
int32_t fe_terrain_set_paint_colors(const uint8_t* rgb,uint32_t count){
 if(!rgb||count<1||count>16)return -1;
 gPaintCount=count;for(uint32_t k=0;k<count*3;k++)gPaintRGB[k]=rgb[k];return 0;
}
int32_t fe_terrain_generate_layered(float seed,float hs,uint32_t continental,float base,float mountain){
 if(!finite(seed)||!finite(hs)||!finite(base)||!finite(mountain)||hs<0||hs>5000||absf(base)>1e5f||absf(mountain)>1e5f)return -1;
 const uint32_t s=(uint32_t(absf(seed)*1000.f))^0x9e3779b9u;
 for(uint32_t j=0;j<W;j++)for(uint32_t i=0;i<W;i++){
  const float x=(float(i)/N-.5f)*size,z=(float(j)/N-.5f)*size;
  const float h=layeredHeight(x,z,seed,hs,s);
  float v;
  if(continental){v=h+1.6f+base+continentalMountain(x,z,seed,mountain,s);}
  else{
   const float r2=(x*x+z*z)/(size*size*.25f);
   const float e2=maxf(absf(x),absf(z))/(size*.5f);
   const float fd=smoothstepf(.62f,.93f,e2);
   v=(h+1.6f-r2*10.f)*(1-fd)-14.f*fd;
  }
  H[j*W+i]=v;materials[j*W+i]=255;
 }
 return 0;
}
int32_t fe_terrain_compute_colors(uint32_t x0,uint32_t x1,uint32_t z0,uint32_t z1){
 if(x0>x1||z0>z1||x1>N||z1>N)return -1;
 for(uint32_t j=z0;j<=z1;j++)for(uint32_t i=x0;i<=x1;i++)terrainColorAt(i,j);
 return int32_t((x1-x0+1)*(z1-z0+1));
}

int32_t fe_terrain_erode_hydraulic(uint32_t droplet_count,uint32_t max_lifetime,float inertia,float sediment_capacity,float erode_speed,float deposit_speed,float evaporation,float gravity,uint32_t brush_radius_cells,uint32_t seed){
 if(droplet_count<1||droplet_count>200000||max_lifetime<1||max_lifetime>256)return -1;
 if(!finite(inertia)||inertia<0||inertia>1||!finite(sediment_capacity)||sediment_capacity<=0||sediment_capacity>10)return -1;
 if(!finite(erode_speed)||erode_speed<=0||erode_speed>1||!finite(deposit_speed)||deposit_speed<=0||deposit_speed>1)return -1;
 if(!finite(evaporation)||evaporation<0||evaporation>.1f||!finite(gravity)||gravity<=0||gravity>100)return -1;
 if(brush_radius_cells<1||brush_radius_cells>64)return -1;
 const ErosionParams p{max_lifetime,inertia,sediment_capacity,erode_speed,deposit_speed,evaporation,gravity,0,0,0};
 uint32_t rng=seed?seed:0x9e3779b9u;
 return int32_t(eroRun(droplet_count,rng,p));
}
/* Start a live run. Nothing is eroded here: the caller then asks for droplets a
   frame at a time, so the heightfield visibly changes instead of stalling the
   frame. `brush_radius_cells` stays in the signature so the live and the batch
   call take exactly the same arguments. */
int32_t fe_erosion_begin(uint32_t droplet_count,uint32_t max_lifetime,float inertia,float sediment_capacity,float erode_speed,float deposit_speed,float evaporation,float gravity,uint32_t brush_radius_cells,uint32_t seed){
 if(droplet_count<1||droplet_count>200000||max_lifetime<1||max_lifetime>256)return -1;
 if(!finite(inertia)||inertia<0||inertia>1||!finite(sediment_capacity)||sediment_capacity<=0||sediment_capacity>10)return -1;
 if(!finite(erode_speed)||erode_speed<=0||erode_speed>1||!finite(deposit_speed)||deposit_speed<=0||deposit_speed>1)return -1;
 if(!finite(evaporation)||evaporation<0||evaporation>.1f||!finite(gravity)||gravity<=0||gravity>100)return -1;
 if(brush_radius_cells<1||brush_radius_cells>64)return -1;
 eroParams=ErosionParams{max_lifetime,inertia,sediment_capacity,erode_speed,deposit_speed,evaporation,gravity,0,0,0};
 eroRng=seed?seed:0x9e3779b9u;
 eroTotal=droplet_count;eroLeft=droplet_count;eroActive=true;eroResetRect();
 return int32_t(droplet_count);
}
/* Narrow where new droplets start and where they may still change the field.
   radius <= 0 restores the whole map. A live run re-points this at the camera
   target every frame, which is what keeps the uploaded rectangle small. */
int32_t fe_erosion_set_region(float cx,float cz,float radius){
 if(!finite(cx)||!finite(cz)||!finite(radius)||radius>20000.f)return -1;
 float r=radius>0.f?radius:0.f;
 if(r>0.f){
  /* Keep the whole patch inside the field. A patch that hangs over the border
     would clamp its rain onto the edge cells and pile erosion into a stripe, so
     the centre moves inwards instead: a camera aimed at the coast erodes the
     coast, not a wall at x = size/2. */
  const float half=size*.5f;
  if(r>half)r=half;
  const float limit=half-r;
  if(cx<-limit)cx=-limit;else if(cx>limit)cx=limit;
  if(cz<-limit)cz=-limit;else if(cz>limit)cz=limit;
 }
 eroParams.cx=cx;eroParams.cz=cz;eroParams.radius=r;
 return 0;
}
/* Run at most `droplets`, never more than the run has left. Returns the count
   actually run, or -1 when no run is active (finished, cancelled or never
   started) — the caller reads fe_erosion_remaining() to tell "done" apart. */
int32_t fe_erosion_step(uint32_t droplets){
 if(!eroActive)return -1;
 if(droplets>eroLeft)droplets=eroLeft;
 if(!droplets)return 0;   /* a zero slice is a no-op, not a cancel */
 eroRun(droplets,eroRng,eroParams);
 eroLeft-=droplets;
 if(!eroLeft)eroActive=false;
 return int32_t(droplets);
}
/* min_i, min_j, max_i, max_j as uint16 cell indices, inclusive, including the
   normal halo. min_i > max_i means nothing changed since the last reset. */
uint16_t* fe_erosion_dirty_ptr(){return eroRect;}
int32_t fe_erosion_dirty_reset(){eroResetRect();return 0;}
uint32_t fe_erosion_remaining(){return eroLeft;}
uint32_t fe_erosion_total(){return eroTotal;}
int32_t fe_erosion_active(){return eroActive?1:0;}
int32_t fe_erosion_cancel(){eroCancelRun();return 0;}
int32_t fe_terrain_erode_thermal(uint32_t iterations,float talus_angle_tan,float slump_rate){
 if(iterations<1||iterations>512)return -1;
 if(!finite(talus_angle_tan)||talus_angle_tan<.01f||talus_angle_tan>10)return -1;
 if(!finite(slump_rate)||slump_rate<=0||slump_rate>1)return -1;
 const float talus=talus_angle_tan*(size/N);
 for(uint32_t it=0;it<iterations;it++){
  for(uint32_t j=1;j<N;j++)for(uint32_t i=1;i<N;i++){
   const uint32_t k=j*W+i;
   if(H[k]<=0)continue;
   uint32_t best=k;float low=H[k];
   if(H[k-1]<low){low=H[k-1];best=k-1;}
   if(H[k+1]<low){low=H[k+1];best=k+1;}
   if(H[k-W]<low){low=H[k-W];best=k-W;}
   if(H[k+W]<low){low=H[k+W];best=k+W;}
   const float diff=H[k]-low;
   if(diff<=talus)continue;
   const float move=(diff-talus)*slump_rate*.5f;
   H[k]-=move;H[best]+=move;
  }
 }
 return int32_t(iterations);
}

}
